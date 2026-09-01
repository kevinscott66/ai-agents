/**
 * Аудит 2026-08-12: CORS-список разрешённых источников остался от старого домена.
 *
 * Сайт живёт на delabs.space (ребренд 2026-06-20), а в allowlist только
 * dobropalm.tech и localhost. Дыры тут нет — фронт ходит на свой же origin, и
 * браузер CORS не спрашивает, — но список врёт о том, чей это сайт, и любой
 * будущий кросс-оригинный вызов с delabs.space молча получит отказ.
 *
 * Заодно фиксируем то, что список обязан продолжать отвергать: чужие домены и
 * подделки вида evil-delabs.space / delabs.space.evil.tld.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-cors-"));
process.env.SITE_DB_PATH = join(TMP, "cors.db");

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

beforeEach(() => _resetRateLimiter());

async function allowFor(origin: string): Promise<string | null> {
  const r = await fetch(`${base}/api/health`, { headers: { origin } });
  expect(r.status).toBe(200);
  return r.headers.get("access-control-allow-origin");
}

describe("CORS allowlist", () => {
  for (const origin of [
    "https://delabs.space",
    "https://www.delabs.space",
    "https://dobropalm.tech",
    "https://web3.dobropalm.tech",
    "http://localhost:5173",
    "http://127.0.0.1:8790",
  ]) {
    test(`${origin} разрешён`, async () => {
      expect(await allowFor(origin)).toBe(origin);
    });
  }

  for (const origin of [
    "https://evil.tld",
    "https://evil-delabs.space",
    "https://delabs.space.evil.tld",
    "https://delabsspace",
    "not-a-url",
  ]) {
    test(`${origin} не разрешён`, async () => {
      expect(await allowFor(origin)).toBeNull();
    });
  }

  test("preflight отвечает теми же правилами", async () => {
    const r = await fetch(`${base}/api/health`, {
      method: "OPTIONS",
      headers: { origin: "https://delabs.space" },
    });
    expect(r.headers.get("access-control-allow-origin")).toBe(
      "https://delabs.space",
    );
    const r2 = await fetch(`${base}/api/health`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.tld" },
    });
    expect(r2.headers.get("access-control-allow-origin")).toBeNull();
  });
});
