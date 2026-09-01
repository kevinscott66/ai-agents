/**
 * T-320: Voice-message handler extracted from orchestrator-team.ts::buildBot.
 *
 * Discrete `bot.on("voice")` registration. Closes only over the bot, its
 * CharacterDef, the resolved RunningBot, and the chat allowlist — everything
 * else (recordMessage/transcribeVoice/log) is a module import, so the
 * handler is a pure, side-effect-free-to-extract block. Behaviour is unchanged
 * from the inline version (T-109 Whisper transcription flow).
 */
import { Telegraf } from "telegraf";
import type { CharacterDef } from "../characters/index.ts";
import type { RunningBot } from "../lib/types.ts";
import { isAllowlisted } from "../lib/allowlist.ts";
import { recordMessage } from "../lib/memory.ts";
import { transcribeVoice } from "../lib/openai-whisper.ts";
import { log, redactText, redactSender, redactUserId } from "../lib/log.ts";
import { getErrorMessage } from "../lib/errors.ts";
import { agentStopReason } from "../lib/permissions.ts";
import { checkAndConsumeIngestLimit } from "../lib/rate-limits.ts";
import { shouldProcessTrigger } from "../lib/trigger-anti-dup.ts";

/**
 * Потолок на скачивание ogg из Telegram.
 *
 * Аудит 2026-08-12: `await fetch(fileUrl)` стоял без сигнала. Голосовое к
 * этому моменту уже вызвало `sendChatAction("typing")`, так что зависший
 * сокет на api.telegram.org — это «печатает…» навсегда: catch ниже не
 * сработает, извинения пользователь не увидит, в логе не появится ни строки.
 * То есть ровно тот же наблюдаемый отказ, что и у сломанного токена, ради
 * которого весь этот блок и переписывали в «любой отказ — throw».
 *
 * 30 секунд: голосовое — это сотни килобайт с CDN Telegram, а не выгрузка.
 */
export const VOICE_FILE_TIMEOUT_MS = 30_000;

/** Максимальный размер аудио, который допустим для Whisper и памяти процесса. */
export const MAX_VOICE_BYTES = 25 * 1024 * 1024;

/**
 * Read a response without allowing an untrusted CDN body to grow without a
 * bound. Content-Length is only an early rejection: chunk accounting remains
 * necessary because the header can be absent or false.
 */
export async function readResponseBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`голосовое слишком большое: ${declared} байт`);
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`голосовое слишком большое: ${bytes.byteLength} байт`);
    }
    return Buffer.from(bytes);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`голосовое слишком большое: больше ${maxBytes} байт`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

/**
 * Register the voice-message handler on a bot. Only the orchestrator actually
 * transcribes (others early-return) to avoid duplicate processing.
 *
 * @param allowed chat-id allowlist, passed from the orchestrator-team module so
 *   the env-derived source of truth stays there. Fail-closed: пустой список
 *   запрещает всех (lib/allowlist.ts, SEC-5) — не «разрешает всех», как здесь
 *   было написано.
 */
export function registerVoiceHandler(
  bot: Telegraf,
  def: CharacterDef,
  running: RunningBot,
  allowed: string[],
): void {
  // T-109: Handle voice messages for transcription
  bot.on("voice", async (ctx) => {
    try {
      const chatId = ctx.chat.id.toString();
      log.info(
        `[voice][${def.key}] chat=${chatId} from=${redactSender(ctx.from?.id, ctx.from?.username)}`,
      );

      if (!isAllowlisted(chatId, allowed)) {
        // Аудит 2026-08-20: здесь печатался ВЕСЬ allowlist. Триггер
        // недоверенный — строка пишется как раз для чата, которого в
        // списке нет, то есть любой посторонний чат заставлял бота
        // выписать в journalctl полный список рабочих чатов команды.
        // Образец правильного отказа — lib/admin-commands.ts. Размер
        // списка оставлен: он отличает «чата нет» от «список пуст».
        log.info(
          `[voice][${def.key}] chat ${chatId} not in allowlist (${allowed.length} chats)`,
        );
        return;
      }

      // Only orchestrator processes voice messages to avoid duplication
      if (def.key !== "orchestrator") return;

      if (ctx.from?.id === running.id) return;

      // Аудит 2026-08-13: голос шёл мимо обеих проверок текстового пути.
      //
      // Пауза. Та же причина, что и у текста (message-handler.ts): ход агента —
      // это не только вызов инструмента, но и реплика в чат. Здесь она уходит
      // прямым ctx.reply («🎤 Распознано: …»), а до неё — платная расшифровка у
      // Whisper. Поставленный на паузу оркестратор молчал в тексте и отвечал
      // голосом, продолжая тратить.
      const stopReason = agentStopReason(def.key);
      if (stopReason) {
        log.info(
          `[stopped][${def.key}] агент ${stopReason} — голосовое пропущено chat=${chatId}`,
        );
        return;
      }

      // Аудит 2026-08-28: дедупа здесь не было, и объяснялось это тем, что
      // «тот же апдейт видит и bot.on("message"), две точки на один id —
      // гонка». Это неверно. Голосовой хендлер регистрируется РАНЬШЕ
      // текстового (orchestrator-team.ts) и терминален — `next` он не берёт и
      // не зовёт, а telegraf собирает хендлеры в koa-цепочку. Замер на
      // настоящем Telegraf: голосовой апдейт при обоих зарегистрированных
      // хендлерах даёт ["voice"], текстовый — ["message"]. Одного апдейта
      // двумя точками не видит никто, гонки не существует.
      //
      // Зато существовал повтор. Telegram передоставляет неподтверждённый
      // апдейт после рестарта, и без дедупа это второе скачивание файла,
      // вторая ПЛАТНАЯ расшифровка у Whisper, вторая строка `[Voice]` в
      // истории и второе «🎤 Распознано» в чат. Текстовый путь от этого
      // закрыт (message-handler.ts), голосовой — самый дорогой из двух —
      // не был. Ключ тот же (chat_id, tg_message_id), пересечься с текстовым
      // путём он не может: разным апдейтам разные message_id.
      //
      // Порядок как в тексте: пауза -> дедуп -> лимит. Повторный апдейт не
      // должен тратить чужой счётчик.
      if (!shouldProcessTrigger(chatId, ctx.message?.message_id)) {
        log.info(
          `[anti-dup][${def.key}] повторный голосовой апдейт пропущен chat=${chatId} msg_id=${ctx.message?.message_id}`,
        );
        return;
      }

      // Лимит ingest (SEC-3 / T-601). Текстовый хендлер выходит на голосовом
      // апдейте раньше, чем доходит до счётчика (пустой rawText), — значит на
      // этом пути счётчик не тратился вообще. Пользователь, упёршийся в лимит
      // текстом, переключался на голос и продолжал: минута речи стоит дороже
      // сообщения (скачивание с CDN + Whisper). Ключ бакета общий с текстом —
      // это один бюджет на человека в чате, а не отдельная квота на голос.
      // Тихий дроп, как и в тексте: ответ «вы слишком часто» сам по себе
      // усилитель.
      const ingest = checkAndConsumeIngestLimit(chatId, ctx.from?.id);
      if (!ingest.ok) {
        log.warn(
          `[ingest-rate][${def.key}] dropped over-limit voice chat=${chatId} user=${redactUserId(ctx.from?.id)} (${ingest.reason})`,
        );
        return;
      }

      await ctx.sendChatAction("typing");

      // Любой отказ ниже — throw, а не `return`: ловит его catch этого же блока
      // и отвечает пользователю. Раньше три ветки выходили молча, уже показав
      // «печатает…», так что сломанная расшифровка выглядела ровно как
      // задумавшийся бот — и выглядела так неизвестно сколько.
      try {
        // Get voice file info
        const voice = ctx.message.voice;
        if (!voice || !voice.file_id) {
          throw new Error("в апдейте нет voice.file_id");
        }
        if (
          typeof voice.file_size === "number" &&
          voice.file_size > MAX_VOICE_BYTES
        ) {
          throw new Error(`голосовое слишком большое: ${voice.file_size} байт`);
        }

        // Download voice file
        const fileInfo = await ctx.telegram.getFile(voice.file_id);
        if (!fileInfo.file_path) {
          throw new Error("Telegram не вернул file_path для голосового");
        }

        // Токен берём у своего же бота: `file_path` выдан его вызовом getFile и
        // чужим токеном не скачивается. Имя переменной — единственный источник
        // правды, `def.envToken` (characters/index.ts). Тут стояло
        // `process.env.TELEGRAM_TOKEN` — переменной с таким именем в проекте
        // нет ни в .env.example, ни у одного персонажа, поэтому расшифровка не
        // работала вообще ни разу.
        const botToken = process.env[def.envToken];
        if (!botToken) {
          throw new Error(`не задан ${def.envToken} — нечем скачать файл`);
        }

        const fileUrl = `https://api.telegram.org/file/bot${botToken}/${fileInfo.file_path}`;
        const response = await fetch(fileUrl, {
          signal: AbortSignal.timeout(VOICE_FILE_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`не скачался файл голосового: HTTP ${response.status}`);
        }

        const audioBuffer = await readResponseBodyWithLimit(
          response,
          MAX_VOICE_BYTES,
        );

        // Transcribe using OpenAI Whisper
        const transcribedText = await transcribeVoice(audioBuffer, "voice.ogg");

        // Расшифрованная речь — то же содержимое сообщения, что и текст:
        // от того, что оно приехало голосом, публичнее оно не стало.
        // Строка нужна как признак «расшифровка получилась и непустая».
        log.info(`[voice][${def.key}] Transcribed: ${redactText(transcribedText)}`);

        // Store transcribed message in database with note that it's from voice
        recordMessage({
          chatId,
          agentKey: null,
          isBot: false,
          fromUserId: ctx.from?.id.toString() ?? "0",
          fromName: ctx.from?.username ?? ctx.from?.first_name ?? null,
          text: `[Voice] ${transcribedText}`, // Prefix to indicate source
          tgMessageId: ctx.message?.message_id,
          transport: "bot_api",
        });

        // Reply to confirm transcription (simple feedback)
        await ctx.reply(`🎤 Распознано: "${transcribedText.slice(0, 100)}${transcribedText.length > 100 ? "..." : ""}"`);

        // Расшифровка попадает в историю чата — и на следующем ходу агент её
        // видит. Но сама по себе она ходом НЕ становится: `bot.on("message")`
        // этого апдейта не видит вовсе — голосовой хендлер зарегистрирован
        // раньше и терминален (`next` он не зовёт), см. замер в комментарии к
        // дедупу выше. Голосом команду не отдать — только продиктовать текст,
        // который учтётся следующим сообщением. Здесь стояло сначала «will be
        // processed by the normal message handler», потом «message-handler
        // отрабатывает тот же апдейт раньше» — неверны оба.
      } catch (error) {
        // `log.error` вторым аргументом ждёт LogData, а не Error: голый Error
        // сериализуется в `{}` и причина теряется — ровно то, из-за чего
        // сломанный токен ничем себя не выдавал.
        log.error(`[voice][${def.key}] не смог обработать голосовое`, {
          chatId,
          error: getErrorMessage(error),
        });
        // Don't fail silently - let user know there was an issue
        await ctx.reply("Извините, не удалось распознать голосовое сообщение. Попробуйте написать текстом.");
      }
    } catch (error) {
      log.error(`[voice][${def.key}] упал сам хендлер голосовых`, {
        error: getErrorMessage(error),
      });
    }
  });
}
