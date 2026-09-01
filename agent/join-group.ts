import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { requireTelegramApiCredentials } from "./lib/telegram-credentials.ts";
import { decryptEncryptedSession } from "./tools/userbot-login.ts";

const { apiId: API_ID, apiHash: API_HASH } = requireTelegramApiCredentials();
// Аудит 2026-08-28: здесь стоял абсолютный путь машины разработчика.
// Дефолт считаем от модуля, переопределение — из USERBOT_SESSION_PATH
// (`||`, а не `??`: из EnvironmentFile пустая переменная приходит "").
const SESSION_PATH =
  process.env.USERBOT_SESSION_PATH?.trim() ||
  fileURLToPath(new URL("./.session", import.meta.url));
const INVITE = process.argv[2];
if (!INVITE) throw new Error("usage: bun run join-group.ts <invite-hash-or-url>");
const hash = INVITE.replace(/^https?:\/\/t\.me\/\+?/, "").replace(/^\+/, "");

const client = new TelegramClient(
  new StringSession(
    decryptEncryptedSession(
      fs.readFileSync(SESSION_PATH, "utf8").trim(),
      process.env.USERBOT_SESSION_KEY,
    ),
  ),
  API_ID,
  API_HASH,
  { connectionRetries: 3 }
);

await client.connect();
const result = await client.invoke(
  new Api.messages.ImportChatInvite({ hash })
);
console.log("Joined:", JSON.stringify(result, null, 2).slice(0, 800));
await client.disconnect();
process.exit(0);
