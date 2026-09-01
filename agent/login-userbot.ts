/**
 * Userbot login через gramjs (MTProto).
 * Получает StringSession и печатает её в stdout / сохраняет в .env.session.
 *
 * Поток:
 *   1. Подключение с api_id=2040 (Telegram Desktop public keys).
 *   2. Отправка кода на номер из TELEGRAM_USERBOT_PHONE.
 *   3. Ждём, пока в /tmp/tg_code появится файл с кодом → читаем.
 *   4. Если 2FA — ждём /tmp/tg_password.
 *   5. Сохраняем StringSession.
 */

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTelegramApiCredentials } from "./lib/telegram-credentials.ts";
import { encryptSession, writeEncryptedSession } from "./tools/userbot-login.ts";

const { apiId: API_ID, apiHash: API_HASH } = requireTelegramApiCredentials();
// Аудит 2026-08-28: здесь стоял номер владельца литералом, и `??` вдобавок
// ломал объявленный контракт (.env.example:125 — «пусто = юзербот не
// поднимается вообще»): пустая строка из EnvironmentFile проходила насквозь.
const PHONE_RAW = process.env.TELEGRAM_USERBOT_PHONE?.trim();
if (!PHONE_RAW) throw new Error("TELEGRAM_USERBOT_PHONE не задан — логиниться некуда");
// Отдельная константа с обещанным типом: сужение выше tsc не переносит
// внутрь замыкания phoneNumber ниже.
const PHONE: string = PHONE_RAW;

const LOGIN_TMP_DIR = fs.mkdtempSync(join(tmpdir(), "userbot-login-"));
fs.chmodSync(LOGIN_TMP_DIR, 0o700);
const CODE_FILE = join(LOGIN_TMP_DIR, "tg_code");
const PASS_FILE = join(LOGIN_TMP_DIR, "tg_password");
process.on("exit", () => fs.rmSync(LOGIN_TMP_DIR, { recursive: true, force: true }));
const SESSION_OUT =
  process.env.USERBOT_SESSION_PATH?.trim() ||
  fileURLToPath(new URL("./.session", import.meta.url));
const SESSION_KEY_RAW = process.env.USERBOT_SESSION_KEY;
if (!SESSION_KEY_RAW?.trim()) {
  throw new Error("USERBOT_SESSION_KEY обязателен: plaintext-сессии запрещены");
}
const SESSION_KEY: string = SESSION_KEY_RAW;

async function waitForFile(path: string, label: string): Promise<string> {
  console.log(`>>> Жду ${label}. Помести значение в файл: ${path}`);
  // удалим, если остался от прошлого запуска
  if (fs.existsSync(path)) fs.unlinkSync(path);
  while (!fs.existsSync(path)) {
    await sleep(1000);
  }
  const value = fs.readFileSync(path, "utf8").trim();
  fs.unlinkSync(path);
  console.log(`<<< ${label} получен (длина=${value.length}).`);
  return value;
}

async function main() {
  console.log(`API_ID=${API_ID}, phone=${PHONE}`);
  const stringSession = new StringSession("");
  const client = new TelegramClient(stringSession, API_ID, API_HASH, {
    connectionRetries: 5,
  });

  await client.start({
    phoneNumber: async () => PHONE,
    phoneCode: async () => waitForFile(CODE_FILE, "telegram login code"),
    password: async () => waitForFile(PASS_FILE, "2FA cloud password"),
    onError: (err) => {
      console.error("Login error:", err);
    },
  });

  const me = await client.getMe();
  console.log("Login OK as:", JSON.stringify(me, null, 2));

  const session = client.session.save() as unknown as string;
  writeEncryptedSession(SESSION_OUT, encryptSession(session, SESSION_KEY));
  console.log(`>>> StringSession сохранён в ${SESSION_OUT}`);
  console.log("Длина сессии:", session.length);

  await client.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
