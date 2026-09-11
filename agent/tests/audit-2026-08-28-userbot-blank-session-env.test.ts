/**
 * Аудит 2026-08-28: пустая строка из EnvironmentFile считалась заданным
 * значением для пути к сессии и для ключа.
 *
 * `USERBOT_SESSION_PATH ?? "data/userbot.session"` — оператор выбран под
 * `undefined`, а systemd для строки `USERBOT_SESSION_PATH=` в EnvironmentFile
 * отдаёт "" (и " " для `KEY= ` с хвостовым пробелом). Пустая строка проходит
 * `??` насквозь, `existsSync("")` даёт false — и в журнале появляется
 * `[userbot] no session at  — running no-op`: путь в сообщении отсутствует, а
 * дефолт, на который оператор рассчитывал, даже не проверялся. Тот же класс,
 * что уже чинили в `resolveDbPath`, `_envPort`, `_envHour` и `lib/alerting.ts`.
 *
 * Симметрично `USERBOT_SESSION_KEY= ` (пробел): это незаданный обязательный
 * ключ. До первого обращения к сессии запуск обязан перейти в no-op с точной
 * причиной, а plaintext-файл не должен становиться обходом этого правила.
 */
import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { readdirSync, statSync, readFileSync } from "node:fs";
import { startUserbot } from "../lib/userbot.ts";
import type { StartUserbotOpts, UserbotClientLike } from "../lib/userbot.ts";
import { _resetSelfAccounts } from "../lib/userbot-self-sends.ts";
import { log } from "../lib/log.ts";

let dir = "";
let warns: string[] = [];
let warnSpy: ReturnType<typeof spyOn> | null = null;
let seen: string[] = [];

const prevPath = process.env.USERBOT_SESSION_PATH;
const prevKey = process.env.USERBOT_SESSION_KEY;
const prevId = process.env.TELEGRAM_API_ID;
const prevHash = process.env.TELEGRAM_API_HASH;

function fakeClient(): UserbotClientLike {
  return {
    async connect() {
      return true;
    },
    async disconnect() {},
    addEventHandler() {},
    async invoke() {
      throw new Error("не должно вызываться");
    },
    async deleteMessages() {
      throw new Error("не должно вызываться");
    },
    async sendMessage() {
      throw new Error("не должно вызываться");
    },
  } as unknown as UserbotClientLike;
}

function opts(extra: Partial<StartUserbotOpts> = {}): StartUserbotOpts {
  return {
    onMessage: () => {},
    allowedChatIds: [-100500],
    _clientFactory: async (sessionStr: string) => {
      seen.push(sessionStr);
      return fakeClient();
    },
    ...extra,
  };
}

/** Тот же шифр, что пишет tools/userbot-login.ts (encrypt не экспортирован). */
function encrypt(plain: string, passphrase: string): string {
  const key = createHash("sha256").update(passphrase).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(
    ":",
  );
}

beforeEach(() => {
  _resetSelfAccounts();
  seen = [];
  warns = [];
  warnSpy = spyOn(log, "warn").mockImplementation((m: unknown) => {
    warns.push(String(m));
  });
  dir = mkdtempSync(join(tmpdir(), "ub-blank-env-"));
  process.env.TELEGRAM_API_ID = "12345";
  process.env.TELEGRAM_API_HASH = "hash";
  delete process.env.USERBOT_SESSION_KEY;
  delete process.env.USERBOT_SESSION_PATH;
});

afterEach(() => {
  _resetSelfAccounts();
  warnSpy?.mockRestore();
  warnSpy = null;
  rmSync(dir, { recursive: true, force: true });
  // bun гоняет каталог одним процессом — env обязан вернуться (CLAUDE.md §3.8 п.7).
  for (const [k, v] of [
    ["USERBOT_SESSION_PATH", prevPath],
    ["USERBOT_SESSION_KEY", prevKey],
    ["TELEGRAM_API_ID", prevId],
    ["TELEGRAM_API_HASH", prevHash],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("предпосылки", () => {
  test("пустой путь не существует — отказ выглядит как «сессии нет»", () => {
    expect(existsSync("")).toBe(false);
  });

  test("дефолтной сессии в дереве нет, иначе тесты ниже ничего не проверяют", () => {
    expect(existsSync("data/userbot.session")).toBe(false);
  });
});

describe("пустой USERBOT_SESSION_PATH не подменяет дефолт пустотой", () => {
  test('"" — читается дефолт, и он назван в отказе', async () => {
    process.env.USERBOT_SESSION_PATH = "";
    const h = await startUserbot(opts());
    expect(h.isNoop).toBe(true);
    expect(warns.some((w) => w.includes("data/userbot.session"))).toBe(true);
  });

  test("пробелы — тоже дефолт", async () => {
    process.env.USERBOT_SESSION_PATH = "   ";
    await startUserbot(opts());
    expect(warns.some((w) => w.includes("data/userbot.session"))).toBe(true);
  });

  test("пустой sessionPath в opts не сильнее дефолта", async () => {
    await startUserbot(opts({ sessionPath: "" }));
    expect(warns.some((w) => w.includes("data/userbot.session"))).toBe(true);
  });

  test("в отказе не остаётся пустого места вместо пути", async () => {
    process.env.USERBOT_SESSION_PATH = "";
    await startUserbot(opts());
    expect(warns.some((w) => w.includes("no session at  "))).toBe(false);
  });

  test("рабочий путь по-прежнему читается для зашифрованной сессии", async () => {
    const p = join(dir, "u.session");
    writeFileSync(p, encrypt("plain-session", "key"));
    process.env.USERBOT_SESSION_PATH = p;
    process.env.USERBOT_SESSION_KEY = "key";
    await startUserbot(opts());
    expect(seen).toEqual(["plain-session"]);
  });

  test("явный sessionPath по-прежнему сильнее переменной окружения", async () => {
    const p = join(dir, "explicit.session");
    writeFileSync(p, encrypt("from-opts", "key"));
    process.env.USERBOT_SESSION_PATH = join(dir, "env.session");
    process.env.USERBOT_SESSION_KEY = "key";
    await startUserbot(opts({ sessionPath: p }));
    expect(seen).toEqual(["from-opts"]);
  });
});

describe("пробел вместо ключа — это забытый ключ, а не сломанная сессия", () => {
  test("v1: и KEY=' ' — в отказе назван ключ, а не расшифровка", async () => {
    const p = join(dir, "enc.session");
    writeFileSync(p, encrypt("secret-session", "правильный-ключ"));
    process.env.USERBOT_SESSION_PATH = p;
    process.env.USERBOT_SESSION_KEY = " ";
    const h = await startUserbot(opts());
    expect(h.isNoop).toBe(true);
    expect(warns.some((w) => w.includes("USERBOT_SESSION_KEY is required"))).toBe(true);
    expect(warns.some((w) => w.includes("failed to read/decrypt"))).toBe(false);
    expect(seen).toEqual([]);
  });

  test("настоящий ключ расшифровывает как прежде", async () => {
    const p = join(dir, "enc2.session");
    writeFileSync(p, encrypt("secret-session", "правильный-ключ"));
    process.env.USERBOT_SESSION_PATH = p;
    process.env.USERBOT_SESSION_KEY = "правильный-ключ";
    await startUserbot(opts());
    expect(seen).toEqual(["secret-session"]);
  });

  test("ключ не обрезается: пробелы внутри значения — часть парольной фразы", async () => {
    // Обрезать сам ключ нельзя — это сменило бы производный AES-ключ и
    // обесценило уже записанные сессии. Пустым считается только пробельный.
    const pass = " ключ с пробелами ";
    const p = join(dir, "enc3.session");
    writeFileSync(p, encrypt("secret-session", pass));
    process.env.USERBOT_SESSION_PATH = p;
    process.env.USERBOT_SESSION_KEY = pass;
    await startUserbot(opts());
    expect(seen).toEqual(["secret-session"]);
  });

  test("незашифрованная сессия с пробельным ключом не становится обходом", async () => {
    const p = join(dir, "plain.session");
    writeFileSync(p, "plain-session");
    process.env.USERBOT_SESSION_PATH = p;
    process.env.USERBOT_SESSION_KEY = "  ";
    await startUserbot(opts());
    expect(seen).toEqual([]);
    expect(warns.some((w) => w.includes("USERBOT_SESSION_KEY is required"))).toBe(true);
  });
});

describe("применение", () => {
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

  test("ни один читатель пути к сессии не использует ??", () => {
    const bad: string[] = [];
    for (const f of walk(join(import.meta.dir, ".."))) {
      const src = readFileSync(f, "utf8");
      for (const line of src.split("\n")) {
        const t = line.trimStart();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
        if (line.includes("USERBOT_SESSION_PATH") && line.includes("??")) {
          bad.push(`${f}: ${line.trim()}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
