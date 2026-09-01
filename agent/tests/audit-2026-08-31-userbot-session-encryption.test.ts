/** Userbot credentials must never fall back to a plaintext file. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");

test("login requires a nonblank key before writing a session", () => {
  const src = read("agent", "tools", "userbot-login.ts");
  expect(src).toContain("USERBOT_SESSION_KEY обязателен");
  expect(src).toContain("const blob = encryptSession(session, passphrase)");
  expect(src).toContain("writeEncryptedSession(SESSION_PATH, blob)");
  expect(src).not.toContain("passphrase ? encryptSession(session, passphrase) : session");
});

test("new sessions use a salted memory-hard KDF while v1 remains readable", () => {
  const src = read("agent", "tools", "userbot-login.ts");
  expect(src).toContain('"v2",');
  expect(src).toContain("scryptSync");
  expect(src).toContain("randomBytes(16)");
  expect(src).toContain('blob.startsWith("v1:")');
});

test("all production consumers reject non-encrypted session blobs", () => {
  for (const file of [
    ["agent", "lib", "userbot.ts"],
    ["agent", "tools", "daily-draft.ts"],
    ["agent", "tools", "approve-poll.ts"],
    ["agent", "tools", "probe-create-channel.ts"],
    ["agent", "orchestrator-userbot.ts"],
    ["agent", "join-group.ts"],
    ["agent", "send-test.ts"],
    ["agent", "list-dialogs.ts"],
  ]) {
    const src = read(...file);
    expect(src).toContain("decryptEncryptedSession");
    expect(src).not.toMatch(/decryptSession\(blob/);
  }
  const userbot = read("agent", "lib", "userbot.ts");
  expect(userbot).toContain('blob.startsWith("v2:")');
});

test("legacy login also refuses to create plaintext sessions", () => {
  const src = read("agent", "login-userbot.ts");
  expect(src).toContain("USERBOT_SESSION_KEY обязателен");
  expect(src).toContain("encryptSession(session, SESSION_KEY)");
  expect(src).toContain("writeEncryptedSession(SESSION_OUT");
});
