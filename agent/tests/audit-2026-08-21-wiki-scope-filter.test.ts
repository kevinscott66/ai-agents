/**
 * Аудит 2026-08-21: фильтр «Раздел» в Wiki-вью не доставал то, ради чего
 * существует.
 *
 * Список страниц запрашивался БЕЗ `scope`, а фильтровался по нему на клиенте.
 * Сервер режет выдачу по `WIKI_LIST_MAX = 500` ПОСЛЕ применения scope — то
 * есть параметр сужает выборку до потолка, а не после него, и не передавать
 * его значило добровольно отказаться от единственного, что там работает.
 *
 * Замер (600 страниц в `_team`, по три в `qa` и `smm`):
 *
 *   страниц в вики: 606
 *   truncated: true
 *   разделов в выдаче (то, что видит фильтр): _team
 *   страниц qa в клиентском фильтре: 0
 *   страниц qa на сервере при scope=qa: 3
 *
 * Две беды сразу. Страниц `qa` не видно ни одной. И выбрать раздел `qa`, чтобы
 * их достать, тоже нельзя: выпадающий список строился из уже обрезанной
 * выдачи, так что раздела там просто нет. А подсказка под списком советовала
 * ровно это — «уточни раздел» — то есть действие, которое ничего не меняло.
 *
 * `wiki_fts` упорядочен по (scope, slug), и `_team` сортируется раньше любой
 * роли: `_` (0x5F) меньше любой строчной буквы. Так что теряются именно
 * страницы ролей, а `_team` — то, что пишет компактор пачками, — выживает
 * всегда. Форма отказа не случайная, а систематическая.
 *
 * Чинится в две стороны: `scope` уходит на сервер, а список разделов приходит
 * с сервера отдельным полем и считается по всей вике.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_wiki_scope";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { db } from "../lib/db.ts";
import { wikiList, wikiScopes, WIKI_LIST_MAX } from "../lib/memory.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";

const BOT_TOKEN = "test_bot_token_wiki_scope";
const USER_ID = 99_821;
const PREFIX = "a0821-";
/** `_team` заполняем сверх потолка, роли — по чуть-чуть: форма из замера. */
const BULK = WIKI_LIST_MAX + 100;

let server: MiniappServerHandle;
let baseUrl: string;

function initData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "qws",
    user: JSON.stringify({ id: USER_ID, first_name: "WS", is_bot: false }),
  });
}

async function listVia(scope?: string): Promise<{
  pages: Array<{ scope: string; slug: string }>;
  truncated?: boolean;
  scopes?: string[];
}> {
  const qs = scope ? `?scope=${encodeURIComponent(scope)}` : "";
  const r = await fetch(`${baseUrl}/api/wiki/list${qs}`, {
    headers: { "X-Telegram-Init-Data": initData() },
  });
  expect(r.status).toBe(200);
  return (await r.json()) as never;
}

function wipe() {
  db.prepare(`DELETE FROM wiki_fts WHERE slug LIKE ?`).run(`${PREFIX}%`);
}

beforeAll(async () => {
  wipe();
  const ins = db.prepare(
    `INSERT INTO wiki_fts (scope, slug, title, content) VALUES (?,?,?,?)`,
  );
  db.transaction(() => {
    for (let i = 0; i < BULK; i++) {
      ins.run("_team", `${PREFIX}${String(i).padStart(4, "0")}`, `t${i}`, "x");
    }
    for (const s of ["qa", "smm"]) {
      for (let i = 0; i < 3; i++) ins.run(s, `${PREFIX}${s}-${i}`, `${s} ${i}`, "x");
    }
  })();
  server = await startMiniappServer({
    adminUserIds: [USER_ID],
    allowedUserIds: [USER_ID],
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop();
  wipe();
});

describe("wikiScopes — список разделов не зависит от потолка выдачи", () => {
  test("раздел, чьи страницы не влезли в выдачу, всё равно в списке", () => {
    const shown = wikiList(undefined, WIKI_LIST_MAX + 1).slice(0, WIKI_LIST_MAX);
    // Сначала — сам дефект: из выдачи `qa` не выводится.
    expect(shown.some((p) => p.scope === "qa")).toBe(false);
    // А из вики — выводится.
    expect(wikiScopes()).toContain("qa");
    expect(wikiScopes()).toContain("smm");
  });

  test("без повторов и по порядку", () => {
    const s = wikiScopes();
    expect(new Set(s).size).toBe(s.length);
    expect([...s].sort()).toEqual(s);
  });
});

describe("/api/wiki/list — scope сужает выборку ДО потолка", () => {
  test("без scope: обрезано, страниц ролей не видно", async () => {
    const r = await listVia();
    expect(r.truncated).toBe(true);
    expect(r.pages.length).toBe(WIKI_LIST_MAX);
    expect(r.pages.filter((p) => p.scope === "qa")).toHaveLength(0);
  });

  test("со scope: те же страницы находятся и обрезки нет", async () => {
    const r = await listVia("qa");
    expect(r.truncated).toBe(false);
    expect(r.pages.filter((p) => p.slug.startsWith(PREFIX))).toHaveLength(3);
    expect(r.pages.every((p) => p.scope === "qa")).toBe(true);
  });

  test("scopes приходит в ответе и содержит потерянные разделы", async () => {
    const r = await listVia();
    expect(r.scopes).toBeDefined();
    expect(r.scopes).toContain("qa");
    expect(r.scopes).toContain("_team");
  });

  test("scopes полон и при запросе одного раздела — иначе фильтр себя запрёт", async () => {
    // Клиент перезапрашивает список при смене раздела. Если бы `scopes`
    // считался по выдаче, после выбора `qa` в списке остался бы один `qa`
    // и вернуться к остальным было бы нечем.
    const r = await listVia("qa");
    expect(r.scopes).toContain("_team");
    expect(r.scopes).toContain("smm");
  });

  test("неизвестный раздел по-прежнему 400, а не пустой список", async () => {
    const r = await fetch(`${baseUrl}/api/wiki/list?scope=нет-такого`, {
      headers: { "X-Telegram-Init-Data": initData() },
    });
    expect(r.status).toBe(400);
  });
});
