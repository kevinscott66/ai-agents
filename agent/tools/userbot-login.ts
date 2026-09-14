#!/usr/bin/env bun
/**
 * C14: интерактивный MTProto-логин для userbot режима.
 *
 * Используется один раз, чтобы получить StringSession. Сессия шифруется
 * симметричным ключом из обязательной переменной окружения
 * USERBOT_SESSION_KEY.
 *
 * Запуск:
 *   bun run tools/userbot-login.ts
 *
 * Ожидаемые env (читаются из /opt/agent-team/.env через dotenv или ручную загрузку):
 *   TELEGRAM_API_ID
 *   TELEGRAM_API_HASH
 *   TELEGRAM_USERBOT_PHONE
 *   USERBOT_SESSION_KEY (обязательна, для шифрования сессии at-rest)
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Writable } from "node:stream";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

// `??` не годится: из EnvironmentFile пустая переменная приходит "" (аудит
// 2026-08-28), и путь записи сессии стал бы пустой строкой.
const SESSION_PATH = process.env.USERBOT_SESSION_PATH?.trim() || "data/userbot.session";

function maskPhone(p: string): string {
  if (p.length < 6) return p;
  return p.slice(0, 3) + "***" + p.slice(-3);
}

function deriveLegacyKey(passphrase: string): Buffer {
  return createHash("sha256").update(passphrase).digest();
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

export function encryptSession(plain: string, passphrase: string): string {
  const salt = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    "v2",
    salt.toString("base64"),
    iv.toString("base64"),
    tag.toString("base64"),
    enc.toString("base64"),
  ].join(":");
}

/** Replace a session without exposing a partial or world-readable file. */
export function writeEncryptedSession(path: string, blob: string): void {
  const tmpPath = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, blob, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmpPath, path);
  } finally {
    if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
  }
}

export function decryptSession(blob: string, passphrase: string): string {
  if (!blob.startsWith("v1:") && !blob.startsWith("v2:")) return blob; // back-compat: plaintext
  const parts = blob.split(":");
  const version = parts[0];
  let ivB64: string | undefined;
  let tagB64: string | undefined;
  let encB64: string | undefined;
  let key: Buffer;
  if (version === "v2") {
    if (parts.length !== 5 || !parts[1] || !parts[2] || !parts[3] || !parts[4]) {
      throw new Error("invalid v2 userbot session format");
    }
    [ivB64, tagB64, encB64] = [parts[2], parts[3], parts[4]];
    key = deriveKey(passphrase, Buffer.from(parts[1], "base64"));
  } else {
    if (parts.length !== 4 || !parts[1] || !parts[2] || !parts[3]) {
      throw new Error("invalid v1 userbot session format");
    }
    [ivB64, tagB64, encB64] = [parts[1], parts[2], parts[3]];
    key = deriveLegacyKey(passphrase);
  }
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}

/** Decrypt the only format accepted by production userbot consumers. */
export function decryptEncryptedSession(blob: string, passphrase: string | undefined): string {
  if (!passphrase?.trim()) {
    throw new Error("USERBOT_SESSION_KEY is required");
  }
  if (!blob.startsWith("v1:") && !blob.startsWith("v2:")) {
    throw new Error("plaintext userbot sessions are not accepted");
  }
  return decryptSession(blob, passphrase);
}

/**
 * Вопрос в терминал. Интерфейс создаётся на один вопрос и сразу закрывается:
 * `readline.close()` входной поток не закрывает, а держать общий интерфейс
 * нельзя — два интерфейса на одном stdin делили бы ввод с `askHidden`.
 */
async function ask(promptText: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(promptText)).trim();
  } finally {
    rl.close();
  }
}

/**
 * То же, но без эха.
 *
 * Аудит 2026-09-10: приглашение обещало «не покажется», а `rl.question` с
 * обычным output печатает каждый символ — облачный пароль 2FA целиком
 * оставался на экране и в скроллбэке терминала. Это единственный секрет,
 * который здесь вводит человек, и единственный, которого нет ни в `.env`, ни в
 * `agent/data`: он открывает аккаунт Telegram владельца, а не сессию userbot'а.
 * Обещание в тексте приглашения делало проверку ненужной — человек не смотрит
 * на экран, набирая то, что ему пообещали скрыть, и узнаёт о следе постфактум.
 *
 * Эхо печатает сам readline (в TTY он выключает echo драйвера и рисует строку
 * сам), поэтому глушим не терминал, а `output` интерфейса: приглашение пишем
 * напрямую в stdout, а весь вывод readline уходит в /dev/null. Редактирование
 * строки (backspace, Ctrl-U) при этом продолжает работать — меняется только
 * то, куда идёт отрисовка. Приватных полей readline (_writeToOutput) не
 * трогаем: между версиями Bun они не гарантированы — кавычек на имени поэтому
 * нет, они обещали бы, что оно точно есть.
 *
 * `io` — шов для теста: подменить `process.stdin` глобально нельзя, а без
 * подмены проверить «не печатается» нечем. В обоих боевых вызовах он опущен.
 */
export async function askHidden(
  promptText: string,
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input,
    output,
  },
): Promise<string> {
  const devNull = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const rl = readline.createInterface({
    input: io.input,
    output: devNull,
    // Без TTY на входе эха нет и так, а `terminal: true` на трубе включил бы
    // ненужный редактор строки.
    terminal: (io.input as { isTTY?: boolean }).isTTY === true,
  });
  io.output.write(promptText);
  try {
    return (await rl.question("")).trim();
  } finally {
    rl.close();
    // Перевод строки печатал бы readline — тот самый вывод, который заглушен.
    io.output.write("\n");
  }
}

async function main(): Promise<void> {
  const apiIdRaw = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  const phone = process.env.TELEGRAM_USERBOT_PHONE;
  const passphrase = process.env.USERBOT_SESSION_KEY;

  if (!apiIdRaw || !apiHash || !phone) {
    console.error(
      "[userbot-login] нужны TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_USERBOT_PHONE",
    );
    process.exit(1);
  }
  if (!passphrase?.trim()) {
    console.error("[userbot-login] USERBOT_SESSION_KEY обязателен: plaintext-сессии запрещены");
    process.exit(1);
  }
  const apiId = Number(apiIdRaw);
  if (!Number.isFinite(apiId)) {
    console.error("[userbot-login] TELEGRAM_API_ID должен быть числом");
    process.exit(1);
  }

  console.log(`[userbot-login] логиним ${maskPhone(phone)} (apiId=${apiId})`);

  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, apiId, apiHash, {
    connectionRetries: 5,
    baseLogger: new Logger(LogLevel.WARN),
  });

  await client.start({
    phoneNumber: async () => phone,
    phoneCode: async () => ask("[userbot-login] SMS-код от Telegram: "),
    password: async () =>
      askHidden("[userbot-login] облачный пароль (2FA, не покажется): "),
    onError: (err) => {
      console.error("[userbot-login] error:", err.message);
    },
  });

  const session = (client.session as StringSession).save();
  if (!session) {
    console.error("[userbot-login] пустая сессия — что-то пошло не так");
    process.exit(1);
  }

  // Получим self чтобы убедиться что логин рабочий.
  const me = await client.getMe();
  console.log(
    `[userbot-login] ok: id=${me.id} @${me.username ?? "—"} (${me.firstName ?? ""})`,
  );

  // Сохраняем.
  if (!existsSync(dirname(SESSION_PATH))) {
    mkdirSync(dirname(SESSION_PATH), { recursive: true });
  }
  const blob = encryptSession(session, passphrase);
  writeEncryptedSession(SESSION_PATH, blob);
  console.log(
    `[userbot-login] сессия сохранена в ${SESSION_PATH}` +
      " (шифрована aes-256-gcm)",
  );

  await client.disconnect();
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[userbot-login] fatal:", err);
    process.exit(1);
  });
}
