#!/usr/bin/env bun
/** Encrypt an existing plaintext StringSession without contacting Telegram. */
import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs";
import {
  decryptEncryptedSession,
  encryptSession,
  writeEncryptedSession,
} from "./userbot-login.ts";

export function migrateUserbotSession(sessionPath: string, passphrase: string | undefined): void {
  if (!passphrase?.trim()) {
    throw new Error("USERBOT_SESSION_KEY is required");
  }
  if (!existsSync(sessionPath)) {
    throw new Error(`session file not found: ${sessionPath}`);
  }

  const current = readFileSync(sessionPath, "utf8").trim();
  if (!current) throw new Error("session file is empty");
  if (current.startsWith("v2:")) {
    throw new Error("session is already encrypted with the current format");
  }

  const plaintext = current.startsWith("v1:")
    ? decryptEncryptedSession(current, passphrase)
    : current;
  writeEncryptedSession(sessionPath, encryptSession(plaintext, passphrase));
}

function main(): void {
  const sessionPath = process.env.USERBOT_SESSION_PATH?.trim() || "data/userbot.session";
  migrateUserbotSession(sessionPath, process.env.USERBOT_SESSION_KEY);
  const mode = statSync(sessionPath).mode & 0o777;
  if (mode !== 0o600) throw new Error(`refusing insecure session mode: ${mode.toString(8)}`);
  console.log(`[userbot-migrate] encrypted existing session at ${sessionPath}`);
}

if (import.meta.main) {
  try {
    main();
  } catch (err) {
    console.error(`[userbot-migrate] ${(err as Error).message}`);
    process.exit(1);
  }
}
