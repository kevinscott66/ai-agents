/**
 * Аудит 2026-08-28: разработческие скрипты носили в себе машину и человека.
 *
 * Четыре скрипта рядом с входами — `list-dialogs.ts`, `join-group.ts`,
 * `login-userbot.ts`, `send-test.ts` — открывали сессию по абсолютному пути
 * `/Users/dobropalm/programs/ai_agents/agent/.session`. Тот же литерал уже
 * убран из `orchestrator-userbot.ts` (PR #822); здесь он оставался в четырёх
 * копиях, то есть на VPS ни один из них не запускался, а сообщение об ошибке
 * называло каталог, которого на сервере и быть не может.
 *
 * Отдельно `login-userbot.ts`: `TELEGRAM_USERBOT_PHONE ?? "<номер>"` зашивал
 * телефон владельца в исходник и заодно ломал объявленный контракт —
 * `.env.example:125` обещает «пусто = юзербот не поднимается вообще», а из
 * EnvironmentFile пустая переменная приходит "" и проходит `??` насквозь.
 * То есть скрипт либо логинился в личный аккаунт владельца по умолчанию, либо
 * отправлял код на пустую строку. Репозиторий приватный, поэтому это не
 * утечка, но номер в коде — не конфигурация.
 *
 * Проверяется исходником: все четыре скрипта подключаются к Telegram прямо на
 * импорте (top-level await, без `import.meta.main`) — импортировать их в тесте
 * нельзя ни при каких условиях.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = ["list-dialogs.ts", "join-group.ts", "login-userbot.ts", "send-test.ts"] as const;

function read(name: string): string {
  return readFileSync(join(import.meta.dir, "..", name), "utf8");
}

/** Только строки кода: комментарии описывают то, что убрали. */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "data",
  "backups",
  "coverage",
  ".git",
  "tests",
  "miniapp",
  "archive",
  // characters/* — системные промпты (risky: только через PR), и путь в
  // примере MAC_RUN_CLAUDE там настоящий: Mac-мост действительно ходит в
  // этот каталог. Это конфигурация моста, а не забытый литерал.
  "characters",
]);

function walk(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(root, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

const TREE = walk(join(import.meta.dir, ".."));

describe("путь к сессии", () => {
  test("абсолютных путей машины разработчика не осталось во всём дереве", () => {
    // Именно домашний каталог владельца, а не любой `/Users/`: описание
    // MAC_RUN_CLAUDE в tools-schema.ts объясняет модели форму пути и приводит
    // обобщённый `/Users/<имя>/programs/...` — это документация, а не привязка.
    const HOME = ["/Users", "dobropalm"].join("/");
    const bad: string[] = [];
    for (const f of TREE) {
      for (const l of codeLines(readFileSync(f, "utf8"))) {
        if (l.includes(HOME)) bad.push(`${f}: ${l.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("каждый скрипт берёт путь из объявленной переменной окружения", () => {
    for (const name of SCRIPTS) {
      const lines = codeLines(read(name));
      expect(
        lines.some((l) => l.includes("process.env.USERBOT_SESSION_PATH?.trim() ||")),
      ).toBe(true);
    }
  });

  test("дефолт считается от модуля, а не от рабочего каталога", () => {
    for (const name of SCRIPTS) {
      const lines = codeLines(read(name));
      expect(
        lines.some((l) => l.includes('fileURLToPath(new URL("./.session", import.meta.url))')),
      ).toBe(true);
    }
  });

  test("модульный дефолт указывает на .session рядом со скриптом", () => {
    const entry = new URL("../list-dialogs.ts", import.meta.url);
    expect(fileURLToPath(new URL("./.session", entry))).toBe(
      join(import.meta.dir, "..", ".session"),
    );
  });
});

describe("телефон владельца", () => {
  test("номера в исходниках не осталось — ни в коде, ни в комментарии", () => {
    // Литерал вида "+1234567890" в любом виде кавычек или в тексте рядом.
    const bad: string[] = [];
    for (const f of TREE) {
      for (const l of readFileSync(f, "utf8").split("\n")) {
        if (/\+\d{10,}/.test(l)) bad.push(`${f}: ${l.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("пустой TELEGRAM_USERBOT_PHONE — отказ с названной причиной", () => {
    const lines = codeLines(read("login-userbot.ts"));
    expect(lines.some((l) => l.includes("process.env.TELEGRAM_USERBOT_PHONE?.trim()"))).toBe(true);
    expect(lines.some((l) => l.includes("TELEGRAM_USERBOT_PHONE") && l.includes("??"))).toBe(false);
    expect(
      lines.some(
        (l) => l.includes("throw") && l.includes("TELEGRAM_USERBOT_PHONE не задан"),
      ),
    ).toBe(true);
  });

  test("предпосылка: ?? пропустил бы пустую строку из EnvironmentFile", () => {
    const raw: string | undefined = "";
    expect(raw ?? "+10000000000").toBe("");
    expect(raw?.trim() || "fallback").toBe("fallback");
  });
});
