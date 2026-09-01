/**
 * Серверный аудит 2026-08-20. Списочные ручки дайджестов возвращали `body`.
 *
 * `listDigests` и `searchDigests` шли через `SELECT * FROM digests`, то есть
 * тянули полный markdown статьи. Потолок `INGEST_MAX.body` — 200 000 символов,
 * `limit` у `/api/digests` клампится до 100. Значит анонимный
 * `GET /api/digests?limit=100` по заполненной базе собирал ответ порядка
 * двадцати мегабайт, и собирал его синхронным `JSON.stringify` в единственном
 * потоке Bun: пока идёт сериализация, сервер не отвечает никому. То же самое
 * на `?q=` — поиск использовал тот же `SELECT *`.
 *
 * Фронт `body` из списка не читает: единственное чтение — `DigestPage`
 * (`data.body`), а она берёт статью по `/api/digests/:id`. То есть весь объём
 * был чистым усилением нагрузки, доступным снаружи без авторизации.
 *
 * Проверка красная до правки: тело здесь — 120 000 символов, и оба списочных
 * ответа его несли целиком.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-audit0820-"));
process.env.SITE_DB_PATH = join(TMP, "audit.db");

const { seedIfEmpty } = await import("./seed.ts");
const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

const TOKEN = "s3cret-ingest-token-0123456789ab";
const PREV_TOKEN = process.env.SITE_INGEST_TOKEN;

/** Заметно больше любого разумного ответа списка, но втрое ниже потолка ингеста. */
const BIG_BODY = "тело статьи ".repeat(10_000);
const PROBE_ID = "projection-probe";
const MARKER = "УНИКАЛЬНЫЙ-МАРКЕР-ТЕЛА";

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(async () => {
  process.env.SITE_DB_PATH = join(TMP, "audit.db");
  process.env.SITE_INGEST_TOKEN = TOKEN;
  seedIfEmpty();
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
  const res = await fetch(`${base}/api/internal/digests`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: PROBE_ID,
      title: "Дайджест с длинным телом",
      summary: "аннотация зонда",
      body: `${MARKER}\n\n${BIG_BODY}`,
      items: [{ text: "пункт", url: "https://example.com/a" }],
    }),
  });
  expect(res.status).toBe(200);
});

afterAll(() => {
  server.stop(true);
  // CLAUDE.md §3.8.7: env не течёт в соседние файлы тестов.
  if (PREV_TOKEN === undefined) delete process.env.SITE_INGEST_TOKEN;
  else process.env.SITE_INGEST_TOKEN = PREV_TOKEN;
});

beforeEach(() => _resetRateLimiter());

describe("списки дайджестов не тащат body", () => {
  test("/api/digests — карточка зонда без body", async () => {
    const res = await fetch(`${base}/api/digests?limit=100`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { items: Array<Record<string, unknown>> };
    const probe = out.items.find((d) => d.id === PROBE_ID);
    // Зонд в выдаче есть — иначе проверка ниже ничего не значит.
    expect(probe).toBeDefined();
    expect(probe!.body).toBeUndefined();
    // Поля карточки на месте: сузили проекцию, а не выдачу.
    expect(probe!.title).toBe("Дайджест с длинным телом");
    expect(probe!.summary).toBe("аннотация зонда");
    expect(Array.isArray(probe!.items)).toBe(true);
  });

  test("/api/digests — маркер тела не встречается во всём ответе", async () => {
    const text = await (await fetch(`${base}/api/digests?limit=100`)).text();
    expect(text).toContain(PROBE_ID);
    expect(text).not.toContain(MARKER);
  });

  test("/api/digests?q= — поиск тоже без body", async () => {
    const res = await fetch(`${base}/api/digests?q=${encodeURIComponent("зонда")}`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { items: Array<Record<string, unknown>> };
    const probe = out.items.find((d) => d.id === PROBE_ID);
    expect(probe).toBeDefined();
    expect(probe!.body).toBeUndefined();
  });

  test("/api/digests/:id — body по-прежнему отдаётся целиком", async () => {
    const res = await fetch(`${base}/api/digests/${PROBE_ID}`);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { body?: string };
    expect(typeof out.body).toBe("string");
    expect(out.body!).toContain(MARKER);
    expect(out.body!.length).toBeGreaterThan(100_000);
  });
});
