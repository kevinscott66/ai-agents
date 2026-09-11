/**
 * Аудит 2026-08-28: юзербот-дирижёр писал чужие сообщения в лог целиком и
 * искал сессию по абсолютному пути с Mac.
 *
 *  1. `log.info(\`[in] ... text=${text.slice(0, 80)}\`)` и симметричная строка
 *     `[out]`. Это не бот в группе, а личный MTProto-аккаунт владельца: в
 *     обработчик попадает всё, что этому аккаунту написали, включая личку.
 *     Восемьдесят символов чужого текста уезжают в journald на уровне info,
 *     где их видит любой, у кого есть доступ к логам VPS. Боевой путь ровно
 *     это уже не делает — `orchestrator/message-handler.ts:486,805` пишет
 *     `redactText(text)`; здесь остался последний экземпляр.
 *     Заметка `.claude/memory/notes/pii-data-flow-2026-05-28.md` (строка
 *     таблицы «Where it's redacted at egress / log» про orchestrator-userbot.ts)
 *     утверждает, что файл уже переведён на redactText, — заметка устарела,
 *     перевода не было.
 *
 *  2. `const SESSION_PATH = "/Users/dobropalm/programs/ai_agents/agent/.session"`.
 *     Абсолютный путь машины разработчика в файле, который лежит в репозитории
 *     и уезжает на VPS. На сервере такого каталога нет, поэтому запуск падает
 *     на `No StringSession at ...` с путём, которого там и не может быть, —
 *     причина в сообщении названа неправильно.
 *
 * Проверяется исходником: у этого входа нет harness — `main()` вызывается на
 * импорте (без `import.meta.main`), а `requireTelegramApiCredentials()`
 * выполняется на уровне модуля. Импортировать файл в тесте нельзя.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactText } from "../lib/log.ts";

const ENTRY = new URL("../orchestrator-userbot.ts", import.meta.url);
const SRC = readFileSync(ENTRY, "utf8");

/** Только строки кода: комментарии этого же файла цитируют то, что убрали. */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

const CODE = codeLines(SRC);
/** Никогда не сравниваем файл целиком: провал toContain печатает его в лог. */
const has = (needle: string) => CODE.some((l) => l.includes(needle));
const linesWith = (needle: string) => CODE.filter((l) => l.includes(needle));

describe("чужой текст не уезжает в лог целиком", () => {
  test("входящее пишется через redactText", () => {
    expect(has("[in] chat=${chatId} text=${redactText(text)}")).toBe(true);
  });

  test("исходящее пишется через redactText", () => {
    expect(has("[out] chat=${chatId} text=${redactText(reply)}")).toBe(true);
  });

  test("голого среза текста в логах не осталось", () => {
    const bad = CODE.filter((l) => l.includes("log.") && l.includes(".slice("));
    expect(bad).toEqual([]);
  });

  test("ни text, ни reply больше не режутся вручную", () => {
    expect(linesWith("text.slice(")).toEqual([]);
    expect(linesWith("reply.slice(")).toEqual([]);
  });

  test("redactText импортирован, а не переопределён локально", () => {
    expect(has('import { log, redactText } from "./lib/log.ts"')).toBe(true);
  });

  test("предпосылка: redactText не отдаёт середину строки", () => {
    // Именно поэтому замена среза на redactText — не косметика.
    const out = redactText("совершенно приватная переписка владельца");
    expect(out).not.toContain("приватная");
    expect(out).toMatch(/^<len=\d+ first4=.{4} last4=.{4}>$/);
  });
});

describe("путь к сессии не привязан к машине разработчика", () => {
  test("абсолютных путей в файле не осталось", () => {
    expect(linesWith("/Users/")).toEqual([]);
  });

  test("путь берётся из объявленной переменной окружения", () => {
    expect(has("process.env.USERBOT_SESSION_PATH?.trim() ||")).toBe(true);
  });

  test("дефолт считается от модуля, а не от рабочего каталога", () => {
    expect(has('fileURLToPath(new URL("./.session", import.meta.url))')).toBe(true);
    expect(has('import { fileURLToPath } from "node:url"')).toBe(true);
  });

  test("предпосылка: ?? пропустил бы пустую строку из EnvironmentFile", () => {
    // systemd для строки `USERBOT_SESSION_PATH=` отдаёт "", а не undefined.
    const raw: string | undefined = "";
    expect(raw ?? "data/userbot.session").toBe("");
    expect(raw?.trim() || "data/userbot.session").toBe("data/userbot.session");
  });

  test("модульный дефолт указывает на .session рядом с входом", () => {
    const resolved = fileURLToPath(new URL("./.session", ENTRY));
    expect(resolved).toBe(join(import.meta.dir, "..", ".session"));
  });
});
