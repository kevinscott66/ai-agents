/**
 * Аудит 2026-08-12: тело wiki-страницы обходило редактирование контента.
 *
 * miniapp-server.ts объявляет политику явно (см. комментарий над
 * `redactContent`): наблюдателю из MINIAPP_ALLOWED_USER_IDS видны СПИСКИ —
 * кто, что, когда, чем кончилось, — но не ТЕЛА. В числе прямо перечисленного
 * там же: «целиком тело WRITE_WIKI». Для /api/actions это и правда так:
 * payload действия WRITE_WIKI (а в нём поле `content` — вся страница) не-админу
 * заменяется на «(скрыто…)».
 *
 * Ровно то же содержимое отдавал GET /api/wiki/page — без единой проверки прав
 * сверх allowlist. То есть редактирование payload'а в /api/actions не скрывало
 * ничего: достаточно было взять scope/slug из /api/wiki/list (эта ручка тоже
 * открыта) и прочитать страницу целиком через соседний роут. Пишет в вики не
 * человек — компактор решает сам, без подтверждения, и складывает туда выжимку
 * переписки; `_team` при этом один на все чаты.
 *
 * Список остаётся открытым намеренно: scope/slug/title — это метаданные того
 * же класса, что заголовки задач, и без них Wiki-вью нечего показывать.
 * Закрывается именно тело.
 *
 * Второе здесь же: wikiList() ходил в FTS без LIMIT вообще — `SELECT … FROM
 * wiki_fts ORDER BY scope, slug` целиком, в память, в JSON, в один ответ.
 * Вики append-only и растёт от каждого хода компактора у каждой из 12 ролей.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { wikiWrite, WIKI_LIST_MAX } from "../lib/memory.ts";
import { db } from "../lib/db.ts";

const BOT_TOKEN = "test_bot_token_for_wiki_scope";
const ADMIN_ID = 910_001;
const VIEWER_ID = 910_002; // в allowlist, но не админ

// Scope обязан быть настоящим ключом роли: ручки сверяют его с CHARACTERS.
const SCOPE = "smm";
const SLUG = "wiki-scope-probe";
const SECRET_TEXT = "внутренний план запуска и пароль от админки";
const MEMORY_DIR = process.env.MEMORY_DIR ?? "memory";

let server: MiniappServerHandle;
let base: string;

function initDataFor(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `q-${userId}`,
    user: JSON.stringify({ id: userId, first_name: "U" }),
  });
}

async function get(path: string, userId: number): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: { "X-Telegram-Init-Data": initDataFor(userId) },
  });
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID, VIEWER_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;

  wikiWrite({
    scope: SCOPE,
    slug: SLUG,
    title: "Проба доступа",
    content: `# Проба\n\n${SECRET_TEXT}\n`,
  });
});

afterAll(() => {
  db.prepare(`DELETE FROM wiki_fts WHERE scope = ? AND slug LIKE ?`).run(
    SCOPE,
    "wiki-scope-probe%",
  );
  db.prepare(`DELETE FROM wiki_fts WHERE slug LIKE ?`).run("cap-probe-%");
  rmSync(join(MEMORY_DIR, SCOPE, "pages", `${SLUG}.md`), { force: true });
  server.stop();
});

describe("вики в Mini App: список открыт, тело — нет", () => {
  test("наблюдатель видит страницу в списке (метаданные)", async () => {
    const r = await get(`/api/wiki/list?scope=${SCOPE}`, VIEWER_ID);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      pages: { scope: string; slug: string; title: string }[];
    };
    expect(body.pages.some((p) => p.slug === SLUG)).toBe(true);
    // Ровно метаданные: содержимого в списке нет ни у кого.
    expect(JSON.stringify(body)).not.toContain(SECRET_TEXT);
  });

  test("наблюдателю тело страницы не отдаётся", async () => {
    const r = await get(`/api/wiki/page?scope=${SCOPE}&slug=${SLUG}`, VIEWER_ID);
    expect(r.status).toBe(403);
    // И в теле отказа тоже — иначе отказ сам бы всё и разгласил.
    expect(await r.text()).not.toContain(SECRET_TEXT);
  });

  test("админ читает страницу как раньше", async () => {
    const r = await get(`/api/wiki/page?scope=${SCOPE}&slug=${SLUG}`, ADMIN_ID);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { content: string };
    expect(body.content).toContain(SECRET_TEXT);
  });

  test("payload WRITE_WIKI и страница закрыты одинаково", async () => {
    // Смысл фикса: две двери в одну комнату не могут быть заперты по-разному.
    const viaPage = await get(
      `/api/wiki/page?scope=${SCOPE}&slug=${SLUG}`,
      VIEWER_ID,
    );
    const viaActions = await get(`/api/actions?limit=50`, VIEWER_ID);
    expect(viaPage.status).toBe(403);
    expect(await viaActions.text()).not.toContain(SECRET_TEXT);
  });
});

describe("вики в Mini App: список ограничен сверху", () => {
  test("выдача обрезается по потолку и честно об этом говорит", async () => {
    const ins = db.prepare(
      `INSERT INTO wiki_fts(scope, slug, title, content) VALUES (?, ?, ?, ?)`,
    );
    const many = db.transaction((n: number) => {
      for (let i = 0; i < n; i++) {
        ins.run(SCOPE, `cap-probe-${String(i).padStart(5, "0")}`, `T${i}`, "x");
      }
    });
    many(WIKI_LIST_MAX + 25);

    let r: Response;
    try {
      r = await get(`/api/wiki/list?scope=${SCOPE}`, ADMIN_ID);
    } finally {
      // Сразу, а не в afterAll: 525 страниц `cap-probe-*` сортируются раньше
      // `wiki-scope-probe` и выталкивают её за потолок в 500 — тест «наблюдатель
      // видит страницу в списке» падал, если этот выполнялся первым. T-751.
      db.prepare(`DELETE FROM wiki_fts WHERE slug LIKE ?`).run("cap-probe-%");
    }
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      pages: unknown[];
      truncated?: boolean;
    };
    expect(body.pages.length).toBeLessThanOrEqual(WIKI_LIST_MAX);
    // Молча обрезанный список неотличим от полного — а Wiki-вью фильтрует
    // клиентски, то есть «страницы нет» показывалось бы вместо «не влезла».
    expect(body.truncated).toBe(true);
  });
});
