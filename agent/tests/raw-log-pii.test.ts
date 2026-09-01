/**
 * Аудит 2026-08-12: политика редакции PII была написана и не применена ни разу.
 *
 * lib/log.ts экспортирует `redactUserId` и `redactText` с прямой инструкцией в
 * шапке: «Use these around any user-supplied string before it lands in
 * console.log / log.info / log.warn / log.error». Тесты у них есть (t305).
 * Производственных вызовов — ноль: единственные упоминания в репозитории, кроме
 * самого lib/log.ts, лежат в tests/t305-pii-redaction.test.ts.
 *
 * А ровно там, где политика должна была примениться, стояло обратное:
 *
 *   log.info(`[raw][${def.key}] chat=${chatId} from=${ctx.from?.username ??
 *     ctx.from?.id} text=${((…text ?? …caption) ?? "<no-text>").slice(0, 80)}`)
 *
 * То есть username и первые 80 символов КАЖДОГО сообщения — на уровне info,
 * то есть в проде (LOG_LEVEL=info) в journalctl, и до проверки allowlist:
 * достаточно чужому боту-соседу переслать апдейт. Ещё две копии той же строки —
 * `[in]` в том же файле и `[voice]` в orchestrator/voice-handler.ts.
 *
 * Строки эти нужны — они отвечают на вопрос «бот вообще получил апдейт?».
 * Нужен именно он, а не содержимое: `uid:<last4>` держит корреляцию внутри
 * сессии, `<len=N first4=… last4=…>` показывает, что текст непустой и какой
 * примерно, не раскрывая середину. Ровно для этого редакторы и написаны.
 *
 * Инвариант: ни одна строка лога в orchestrator/ не интерполирует сырой
 * username и сырой текст сообщения.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import type { Telegraf } from "telegraf";
import { registerVoiceHandler } from "../orchestrator/voice-handler.ts";
import { CHARACTERS } from "../characters/index.ts";
import type { RunningBot } from "../lib/types.ts";
import { log, redactText, redactUserId } from "../lib/log.ts";
import { cleanupChat } from "./_helpers.ts";

const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;

describe("редакторы применяются там, где для них написана инструкция", () => {
  // Аудит 2026-08-12 (второй проход): починка была односторонней. Правило
  // применили к двум файлам из трёх, а третий — orchestrator/services.ts —
  // делает то же самое и хуже: recordUserbotMessage пишет `from=<имя>
  // text=<80 символов>` на каждое сообщение, а у сессии MTProto нет privacy
  // mode, то есть она видит ВСЁ, а не только обращения к боту. Плюс строка
  // `[voice] Transcribed: …` — это уже расшифрованная речь, и её прежняя
  // формулировка не подходила под шаблон `text=${…}`, которым проверяли.
  //
  // Аудит 2026-08-12 (третий проход): граница MTProto-ингеста переехала из
  // services.ts в lib/userbot-ingest.ts — вместе со строкой лога. Список идёт
  // за кодом; services.ts оставлен, чтобы формулировка не вернулась туда снова.
  const FILES = [
    "../orchestrator/message-handler.ts",
    "../orchestrator/voice-handler.ts",
    "../orchestrator/services.ts",
    "../lib/userbot-ingest.ts",
  ];

  /**
   * Файлы, где строка «апдейт дошёл» обязана существовать. В services.ts после
   * переезда её нет и быть не должно — там остался только запуск сервисов.
   */
  const INGEST_FILES = [
    "../orchestrator/message-handler.ts",
    "../orchestrator/voice-handler.ts",
    "../lib/userbot-ingest.ts",
  ];

  /**
   * Вызовы логгера ЦЕЛИКОМ, включая многострочные: `[in]` в message-handler
   * разнесён на три строки, и построчный фильтр его не видел бы — то есть
   * тест молча проверял бы половину файла.
   */
  function logLines(src: string): string[] {
    const out: string[] = [];
    const re = /log\.(?:info|warn|error|debug)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      for (; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")") {
          depth--;
          if (depth === 0) break;
        }
      }
      out.push(src.slice(m.index, i + 1));
    }
    return out;
  }

  for (const rel of FILES) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");

    test(`${rel}: сырой username не уходит в лог`, () => {
      // Именно прямая интерполяция. Внутри редактора имя встречаться может и
      // должно — он для того и вызван.
      //
      // Аудит 2026-08-28: маскируется теперь и `redactSender(id, username)`.
      // Прежде маскировался только `redactUserId`, и переход на парный
      // редактор — тот самый, ради которого его и завели, — валил эту
      // проверку: аргументом там стоит `ctx.from?.username`. Прежний
      // комментарий защищал здесь `redactUserId(id ?? username)`; это как раз
      // антипаттерн, разобранный в докблоке `redactSender` (`lib/log.ts`):
      // имя он режет как идентификатор, `redactUserId("ivanov")` даёт
      // `uid:anov`, и разные люди в логе становятся одним отправителем.
      const bad = logLines(src).filter((l) =>
        /\$\{[^}]*ctx\.from\?\.username/.test(
          l.replace(/redact(?:UserId|Sender)\([^)]*\)/g, "redact(…)"),
        ),
      );
      expect(bad).toEqual([]);
    });

    test(`${rel}: сырой текст сообщения не уходит в лог`, () => {
      // Отпечаток прежней формулировки: срез сообщения прямо в шаблоне.
      const bad = logLines(src).filter((l) =>
        /text=\$\{(?!redactText)/.test(l),
      );
      expect(bad).toEqual([]);
    });

    test(`${rel}: сырое имя отправителя не уходит в лог`, () => {
      // `from=${m.fromName ?? m.fromUserId}` в services.ts: имя пользователя
      // Telegram — то же самое PII, что и username, только другим полем.
      //
      // Аудит 2026-08-27: в allowlist добавлен `redactSender` — редактор,
      // который выбирает форму по тому, что реально есть (`uid:` для id,
      // `name:` для имени). Он и появился потому, что прежний `redactUserId(id
      // ?? name)` резал имя как идентификатор. Проверка остаётся текстовой,
      // поэтому список редакторов приходится вести руками: смысл её в том, что
      // в `from=` не может стоять сырое поле, а не в имени конкретной функции.
      const bad = logLines(src).filter((l) =>
        /from=\$\{(?!redactUserId|redactSender)/.test(l),
      );
      expect(bad).toEqual([]);
    });

    test(`${rel}: расшифрованная речь не уходит в лог`, () => {
      // `[voice] Transcribed: ${transcribedText.slice(0, 100)}` — содержимое
      // сообщения ничем не лучше от того, что оно приехало голосом.
      const bad = logLines(src).filter((l) =>
        /Transcribed:\s*\$\{(?!redactText)/.test(l),
      );
      expect(bad).toEqual([]);
    });

    if (INGEST_FILES.includes(rel)) {
      test(`${rel}: факт получения апдейта по-прежнему логируется`, () => {
        // Обратная сторона: «убрать PII» не должно означать «убрать строку».
        // Без неё пропадает единственный ответ на вопрос, дошёл ли апдейт.
        expect(logLines(src).some((l) => /redact(?:UserId|Sender)\(/.test(l))).toBe(true);
      });
    }
  }
});

describe("строка [voice] живьём", () => {
  const running: RunningBot = {
    def: ORCH,
    bot: {} as Telegraf,
    username: "lead_bot",
    id: 4242,
  };
  const CHAT = 999_314_009;
  const infoSpy = spyOn(log, "info");
  let lines: string[] = [];

  function handler(): (ctx: any) => Promise<void> {
    let captured: ((ctx: any) => Promise<void>) | undefined;
    const bot = {
      on: (event: string, fn: (ctx: any) => Promise<void>) => {
        if (event === "voice") captured = fn;
      },
    } as unknown as Telegraf;
    registerVoiceHandler(bot, ORCH, running, [String(CHAT)]);
    return captured!;
  }

  beforeEach(() => {
    lines = [];
    infoSpy.mockImplementation(((msg: string) => {
      lines.push(msg);
    }) as any);
  });

  afterEach(() => {
    cleanupChat(CHAT);
  });

  afterAll(() => {
    infoSpy.mockRestore();
  });

  test("username в строку не попадает, uid:<last4> — попадает", async () => {
    // Не-allowlisted чат: до сети не доходим, а интересующая строка пишется
    // ДО проверки allowlist — как и в проде.
    await handler()({
      chat: { id: 1 },
      from: { id: 123456789, username: "very_private_handle" },
      message: { voice: { file_id: "F" }, message_id: 1 },
      sendChatAction: async () => {},
      reply: async () => {},
    });

    const raw = lines.find((l) => l.includes("[voice]"));
    expect(raw).toBeDefined();
    expect(raw).not.toContain("very_private_handle");
    expect(raw).toContain(redactUserId(123456789));
  });
});

describe("редакторы дают то, ради чего строка и нужна", () => {
  test("uid коррелирует, но не идентифицирует", () => {
    expect(redactUserId("123456789")).toBe("uid:6789");
    expect(redactUserId("123456789")).toBe(redactUserId(123456789));
  });

  test("текст виден как факт, но не как содержимое", () => {
    const out = redactText("секретный план на понедельник");
    expect(out).toContain("len=");
    expect(out).not.toContain("понедельник");
  });
});
