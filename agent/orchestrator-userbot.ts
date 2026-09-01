/**
 * Дирижёр — userbot-режим (MTProto через gramjs).
 * Подключается к существующей StringSession, слушает группы из TELEGRAM_ALLOWED_GROUP_IDS,
 * отвечает через Claude (Anthropic SDK напрямую).
 *
 * Этап 1: bare-bones smoke test без eliza-runtime.
 * Eliza-память / actions подключим, когда базовый цикл будет работать стабильно.
 */

import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { NewMessage, type NewMessageEvent } from "telegram/events/index.js";
import Anthropic from "@anthropic-ai/sdk";
import { callAnthropic } from "./lib/anthropic-client.ts";
import { runTextViaAgentSdk, useAgentSdk } from "./lib/agent-sdk-runtime.ts";
import { BudgetExceededError } from "./lib/token-budget.ts";
import { log, redactText } from "./lib/log.ts";
import { describeAllowlist } from "./lib/allowlist.ts";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { requireTelegramApiCredentials } from "./lib/telegram-credentials.ts";
import { canonicalChatId } from "./lib/userbot.ts";
import { decryptEncryptedSession } from "./tools/userbot-login.ts";

const { apiId: API_ID, apiHash: API_HASH } = requireTelegramApiCredentials();
// Аудит 2026-08-28: здесь стоял абсолютный путь машины разработчика
// (/Users/...), а файл уезжает на VPS — запуск падал с сообщением про
// каталог, которого на сервере и быть не может. Дефолт считаем от самого
// модуля, чтобы не зависеть от рабочего каталога, а переопределение берём
// из уже объявленной USERBOT_SESSION_PATH. Оператор `||`, а не `??`:
// systemd для строки `USERBOT_SESSION_PATH=` в EnvironmentFile отдаёт "",
// а не undefined.
const SESSION_PATH =
  process.env.USERBOT_SESSION_PATH?.trim() ||
  fileURLToPath(new URL("./.session", import.meta.url));
const ALLOWED_GROUP_IDS = (process.env.TELEGRAM_ALLOWED_GROUP_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SYSTEM_PROMPT = `Ты — Дирижёр, главный агент-оркестратор команды из 12 ИИ-специалистов в Telegram.
Команда: PM, Product, Backend Dev, Frontend Dev, Telegram Bot Dev, AI/LLM Engineer, QA, SMM, Copywriter, Designer, Action/Permissions.

Правила:
- Отвечай по-русски, кратко, по делу.
- Если запрос ясен — формулируй план и сразу скажи, кому из команды его передал бы (роль).
- Если запрос непонятен — задавай уточняющие вопросы.
- На этапе 1 ты единственный агент онлайн, остальные подключатся позже.
- Тон: спокойный, уверенный, профессиональный, без воды и эмодзи.`;

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  const subscriptionMode = useAgentSdk();
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if ((subscriptionMode && !oauthToken) || (!subscriptionMode && !apiKey)) {
    throw new Error("Claude subscription or ANTHROPIC_API_KEY is required");
  }
  if (!fs.existsSync(SESSION_PATH))
    throw new Error(`No StringSession at ${SESSION_PATH}. Run login-userbot.ts first.`);

  const sessionStr = decryptEncryptedSession(
    fs.readFileSync(SESSION_PATH, "utf8").trim(),
    process.env.USERBOT_SESSION_KEY,
  );
  const session = new StringSession(sessionStr);
  const client = new TelegramClient(session, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  const model = process.env.ANTHROPIC_LARGE_MODEL?.trim() || "claude-sonnet-4-6";

  await client.connect();
  const me = await client.getMe();
  log.info(`Дирижёр в эфире от лица: ${me.firstName ?? ""} (id=${me.id})`);
  log.info(`Allowed groups: ${describeAllowlist(ALLOWED_GROUP_IDS)}`);

  client.addEventHandler(async (event: NewMessageEvent) => {
    const msg = event.message;
    if (!msg || msg.out) return; // свои сообщения игнорим

    const chatId = msg.chatId?.toString();
    if (!chatId) return;
    // Аудит 2026-08-19: последняя копия старой границы. Две дыры в четырёх
    // строках, обе уже закрытые в боевом пути (lib/userbot.ts):
    //
    //  1. fail-open. `ALLOWED_GROUP_IDS.length > 0 &&` означало, что пустой или
    //     криво распарсенный TELEGRAM_ALLOWED_GROUP_IDS (лишняя кавычка → всё
    //     выпадает на .filter(Boolean)) открывает ЛЮБОЙ чат. Юзербот работает
    //     от личного аккаунта владельца, то есть на каждое входящее в личке
    //     уходил бы ответ Claude за его же токены.
    //  2. `chatId.includes(norm)` — подстрока. Разрешённый 1234567890 пускал и
    //     11234567890, и 1234567890123: чужому чату достаточно содержать
    //     разрешённый id как кусок.
    //
    // canonicalChatId делает и то и другое правильно: пустой allowlist →
    // null (fail-closed), сравнение — точное равенство «ободранных» id.
    if (canonicalChatId(ALLOWED_GROUP_IDS, chatId) === null) return;

    const text = msg.message ?? "";
    if (!text.trim()) return;

    // Аудит 2026-08-28: юзербот работает от личного аккаунта владельца, то
    // есть сюда приходит и личка. Полный текст на уровне info виден всем,
    // у кого есть журнал VPS; боевой путь давно пишет redactText
    // (orchestrator/message-handler.ts:486).
    log.info(`[in] chat=${chatId} text=${redactText(text)}`);

    try {
      const reply = subscriptionMode
        ? await runTextViaAgentSdk({
            system: SYSTEM_PROMPT,
            prompt: text,
            maxTurns: 1,
            model: process.env.ANTHROPIC_LARGE_MODEL_SDK?.trim() || "sonnet",
            agentKey: "orchestrator",
          })
        : (await callAnthropic(
            {
              model,
              max_tokens: 512,
              system: SYSTEM_PROMPT,
              messages: [{ role: "user", content: text }],
            },
            undefined,
            "orchestrator",
          )).content
            .filter((b): b is Anthropic.TextBlock => b.type === "text")
            .map((b) => b.text)
            .join("\n")
            .trim();
      if (!reply) return;
      await client.sendMessage(msg.peerId, {
        message: reply,
        replyTo: msg.id,
      });
      log.info(`[out] chat=${chatId} text=${redactText(reply)}`);
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        log.info(`[budget] swallow: ${err.message}`);
        return;
      }
      log.error("LLM error", { error: (err as Error)?.message, stack: (err as Error)?.stack });
    }
  }, new NewMessage({}));

  log.info("Слушаю сообщения. Ctrl+C — остановить.");
  process.on("SIGINT", async () => {
    await client.disconnect();
    process.exit(0);
  });

  await new Promise(() => {});
}

main().catch((err) => {
  log.error("Fatal", { error: (err as Error)?.message, stack: (err as Error)?.stack });
  process.exit(1);
});
