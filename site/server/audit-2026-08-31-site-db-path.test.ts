/** A blank EnvironmentFile value must not silently select SQLite's temp DB. */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveDbPath } from "./db.ts";

const previous = process.env.SITE_DB_PATH;
const fallback = join(import.meta.dir, "data", "site.db");

afterEach(() => {
  if (previous === undefined) delete process.env.SITE_DB_PATH;
  else process.env.SITE_DB_PATH = previous;
});

test("blank SITE_DB_PATH falls back to the durable default", () => {
  process.env.SITE_DB_PATH = "";
  expect(resolveDbPath()).toBe(fallback);
});

test("whitespace SITE_DB_PATH falls back to the durable default", () => {
  process.env.SITE_DB_PATH = "  \t ";
  expect(resolveDbPath()).toBe(fallback);
});

test("explicit :memory: remains available to isolated tests", () => {
  process.env.SITE_DB_PATH = ":memory:";
  expect(resolveDbPath()).toBe(":memory:");
});
