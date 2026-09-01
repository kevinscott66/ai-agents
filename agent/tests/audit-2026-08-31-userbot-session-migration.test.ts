import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptEncryptedSession } from "../tools/userbot-login.ts";
import { migrateUserbotSession } from "../tools/migrate-userbot-session.ts";

let dir = "";

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

test("migrates an existing plaintext session without a Telegram login", () => {
  dir = mkdtempSync(join(tmpdir(), "ub-migrate-"));
  const path = join(dir, "userbot.session");
  writeFileSync(path, "existing-string-session\n", { mode: 0o644 });

  migrateUserbotSession(path, "migration-key");

  const blob = readFileSync(path, "utf8");
  expect(blob.startsWith("v2:")).toBe(true);
  expect(decryptEncryptedSession(blob, "migration-key")).toBe("existing-string-session");
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("does not rewrite an already encrypted session", () => {
  dir = mkdtempSync(join(tmpdir(), "ub-migrate-"));
  const path = join(dir, "userbot.session");
  writeFileSync(path, "v2:already:encrypted:blob", { mode: 0o600 });

  expect(() => migrateUserbotSession(path, "migration-key")).toThrow(/already encrypted/);
  expect(readFileSync(path, "utf8")).toBe("v2:already:encrypted:blob");
});
