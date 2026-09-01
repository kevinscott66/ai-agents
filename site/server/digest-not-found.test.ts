/**
 * Аудит 2026-08-13: `/digest/<чего-нет>` отвечал **200**.
 *
 * Путь заведомо статейный — `digestIdFromPath` его распознаёт, — но если
 * статьи в БД нет, `digestShellResponse` возвращал null и запрос проваливался
 * в общий SPA-фолбэк: тот же `index.html`, статус 200. Человек разницы не
 * видит (клиентский роутер рисует «не найдено»), а всё, что читает статус,
 * считает страницу существующей: краулер индексирует, монитор аптайма держит
 * зелёным, `curl -f` молчит.
 *
 * Это прямое продолжение T-743. Восемь тестовых публикаций тогда удалили из
 * БД — и их URL продолжали отвечать 200, то есть для поисковика оставались
 * валидными ещё на цикл обхода. Удаление данных обязано выражаться в статусе,
 * иначе оно не удаление, а сокрытие.
 *
 * Оболочка при этом отдаётся та же самая: переход по битой внутренней ссылке
 * не должен ломать SPA. Меняется статус и `X-Robots-Tag`, не содержимое.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-404-"));
const DIST = join(TMP, "dist");

// Оболочка — настоящая: подмена каталога не должна подменять содержимое.
mkdirSync(DIST, { recursive: true });
writeFileSync(
  join(DIST, "index.html"),
  readFileSync(join(import.meta.dir, "..", "web", "index.html"), "utf8"),
);

process.env.SITE_DB_PATH = join(TMP, "404.db");
process.env.SITE_WEB_DIST = DIST;

const { seedIfEmpty } = await import("./seed.ts");
const { listDigests, getDb } = await import("./db.ts");
const { makeFetchHandler } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  seedIfEmpty();
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  delete process.env.SITE_WEB_DIST;
  rmSync(TMP, { recursive: true, force: true });
});

describe("/digest/<id> несуществующей статьи", () => {
  test("отвечает 404, а не 200 с оболочкой главной", async () => {
    const r = await fetch(`${base}/digest/такой-статьи-нет-2026-08-13`);
    expect(r.status).toBe(404);
    // Оболочку всё-таки отдаём: клиентский роутер покажет своё «не найдено».
    expect(r.headers.get("content-type") ?? "").toContain("text/html");
    expect(await r.text()).toContain("<html");
  });

  test("удалённая статья перестаёт отвечать 200 — сценарий T-743", async () => {
    // Живая статья из сида: сначала 200, после удаления — 404. Ровно то, что
    // должно было произойти с восемью тестовыми публикациями.
    const items = listDigests(1, 0);
    expect(items.length).toBe(1);
    const id = items[0]!.id;

    const alive = await fetch(`${base}/digest/${encodeURIComponent(id)}`);
    expect(alive.status).toBe(200);

    getDb().prepare(`DELETE FROM digests WHERE id = ?`).run(id);

    const gone = await fetch(`${base}/digest/${encodeURIComponent(id)}`);
    expect(gone.status).toBe(404);
  });

  test("404 статьи помечен noindex", async () => {
    const r = await fetch(`${base}/digest/нет-и-не-было`);
    expect(r.headers.get("x-robots-tag") ?? "").toContain("noindex");
  });

  test("обычный маршрут SPA по-прежнему 200", async () => {
    // Правка касается ТОЛЬКО путей вида /digest/<id>. Клиентские маршруты
    // сервер знать не обязан — им и дальше отвечает оболочка со статусом 200.
    for (const p of ["/", "/unlocks", "/about"]) {
      const r = await fetch(`${base}${p}`);
      expect(r.status).toBe(200);
    }
  });

  test("вложенный путь под /digest/ статейным не считается", async () => {
    // digestIdFromPath не матчит вложенность — такой путь идёт обычным
    // фолбэком, поведение не менялось.
    const r = await fetch(`${base}/digest/a/b`);
    expect(r.status).toBe(200);
  });
});
