/**
 * Тестовая отправка одного сообщения в группу от лица userbot.
 */
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { requireTelegramApiCredentials } from "./lib/telegram-credentials.ts";
import { decryptEncryptedSession } from "./tools/userbot-login.ts";

const { apiId: API_ID, apiHash: API_HASH } = requireTelegramApiCredentials();
const CHAT_ID = Number(process.env.TELEGRAM_ALLOWED_GROUP_IDS?.split(",")[0]);
// Аудит 2026-08-28: здесь стоял абсолютный путь машины разработчика.
// Дефолт считаем от модуля, переопределение — из USERBOT_SESSION_PATH
// (`||`, а не `??`: из EnvironmentFile пустая переменная приходит "").
const SESSION_PATH =
  process.env.USERBOT_SESSION_PATH?.trim() ||
  fileURLToPath(new URL("./.session", import.meta.url));

const sessionStr = decryptEncryptedSession(
  fs.readFileSync(SESSION_PATH, "utf8").trim(),
  process.env.USERBOT_SESSION_KEY,
);
const client = new TelegramClient(
  new StringSession(sessionStr),
  API_ID,
  API_HASH,
  { connectionRetries: 3 }
);

await client.connect();
const sent = await client.sendMessage(CHAT_ID, {
  message:
    "Дирижёр на связи. Этап 1: userbot-режим активен. Готов принимать запросы — пиши обычным сообщением, отвечу через Claude.",
});
console.log("Sent id:", sent.id);
await client.disconnect();
process.exit(0);
