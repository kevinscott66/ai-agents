/**
 * P1 (2026-06-09): Wiki-вью в Mini App — backend эндпоинты
 * GET /api/wiki/list и GET /api/wiki/page.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_wiki";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { wikiWrite } from "../lib/memory.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";

const BOT_TOKEN = "test_bot_token_for_wiki";
const USER_ID = 99001;

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "qwiki",
    user: JSON.stringify({
      id: USER_ID,
      username: "wikitest",
      first_name: "Wiki",
      is_bot: false,
    }),
  });
}

let server: MiniappServerHandle;
let baseUrl: string;

beforeAll(async () => {
  // Засеять минимум одну страницу.
  wikiWrite({
    scope: "_team",
    slug: "wiki-view-test-page",
    title: "Wiki View Test",
    content: "Это содержимое тестовой страницы для проверки эндпоинта.",
  });
  server = await startMiniappServer({
    adminUserIds: [USER_ID],
    allowedUserIds: [USER_ID],
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop();
  // Артефакт-страницу убираем за собой. Путь берём из MEMORY_DIR, а не из
  // process.cwd(): по cwd этот rmSync бил в РЕАЛЬНЫЙ agent/memory, где такая
  // страница когда-то была закоммичена, и каждый прогон гейта оставлял ` D` на
  // git-tracked файл (аудит 2026-08-20).
  try {
    rmSync(
      join(
        process.env.MEMORY_DIR ?? "memory",
        "_team",
        "projects",
        "wiki-view-test-page.md",
      ),
      { force: true },
    );
  } catch {
    /* best-effort */
  }
});

describe("GET /api/wiki/list", () => {
  test("возвращает список страниц с засеянной", async () => {
    const res = await fetch(`${baseUrl}/api/wiki/list`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as {
      pages: { scope: string; slug: string; title: string }[];
    };
    expect(Array.isArray(data.pages)).toBe(true);
    const hit = data.pages.find((p) => p.slug === "wiki-view-test-page");
    expect(hit).toBeTruthy();
    expect(hit?.scope).toBe("_team");
    expect(hit?.title).toBe("Wiki View Test");
  });

  test("неизвестный scope → 400", async () => {
    const res = await fetch(`${baseUrl}/api/wiki/list?scope=__nope__`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });
    expect(res.status).toBe(400);
  });

  test("без auth → 401", async () => {
    const res = await fetch(`${baseUrl}/api/wiki/list`);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/wiki/page", () => {
  test("возвращает содержимое страницы", async () => {
    const res = await fetch(
      `${baseUrl}/api/wiki/page?scope=_team&slug=wiki-view-test-page`,
      { headers: { "X-Telegram-Init-Data": freshInitData() } },
    );
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { content: string; slug: string };
    expect(data.slug).toBe("wiki-view-test-page");
    expect(data.content).toContain("тестовой страницы");
  });

  test("несуществующий slug → 404", async () => {
    const res = await fetch(
      `${baseUrl}/api/wiki/page?scope=_team&slug=does-not-exist-xyz`,
      { headers: { "X-Telegram-Init-Data": freshInitData() } },
    );
    expect(res.status).toBe(404);
  });

  test("path-traversal slug → 400, не 500", async () => {
    const res = await fetch(
      `${baseUrl}/api/wiki/page?scope=_team&slug=${encodeURIComponent("../../etc/passwd")}`,
      { headers: { "X-Telegram-Init-Data": freshInitData() } },
    );
    expect(res.status).toBe(400);
  });

  test("неизвестный scope → 400", async () => {
    const res = await fetch(
      `${baseUrl}/api/wiki/page?scope=__nope__&slug=x`,
      { headers: { "X-Telegram-Init-Data": freshInitData() } },
    );
    expect(res.status).toBe(400);
  });
});
