/**
 * Проба: может ли userbot-аккаунт создать TG-канал и добавить бота админом
 * через gramjs (до постройки полноценных actions). Только ручная проверка.
 * usage: bun tools/probe-create-channel.ts "<title>" "<about>" [botUsername]
 */
import { readFileSync, existsSync } from "node:fs";
import { decryptEncryptedSession } from "./userbot-login.ts";

const title = process.argv[2] || "AI Team Test";
const about = process.argv[3] || "Канал команды AI-агентов";
const botUser = process.argv[4];

const sessionPath = process.env.USERBOT_SESSION_PATH?.trim() || "data/userbot.session";
const passphrase = process.env.USERBOT_SESSION_KEY;
const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;
if (!existsSync(sessionPath) || !apiId || !apiHash) {
  console.error("missing session/api creds"); process.exit(1);
}
const blob = readFileSync(sessionPath, "utf8").trim();
const sessionStr = decryptEncryptedSession(blob, passphrase);

const tg = await import("telegram");
const { StringSession } = await import("telegram/sessions/index.js");
const { Api } = tg;
const client = new tg.TelegramClient(new StringSession(sessionStr), apiId, apiHash, { connectionRetries: 3 });
await client.connect();

const res: any = await client.invoke(
  new Api.channels.CreateChannel({ title, about, broadcast: true }),
);
const chat = res.chats?.[0];
const channelId = chat?.id?.toString?.() ?? "?";
console.log("CHANNEL_CREATED id=", channelId, "title=", chat?.title);

if (botUser && chat) {
  const inputChannel = new Api.InputChannel({ channelId: chat.id, accessHash: chat.accessHash });
  const botEntity = await client.getInputEntity(botUser);
  await client.invoke(
    new Api.channels.EditAdmin({
      channel: inputChannel,
      userId: botEntity,
      adminRights: new Api.ChatAdminRights({
        postMessages: true, editMessages: true, deleteMessages: true,
        inviteUsers: true, changeInfo: true,
      }),
      rank: "agent",
    }),
  );
  console.log("BOT_ADDED_ADMIN", botUser);
}
await client.disconnect();
process.exit(0);
