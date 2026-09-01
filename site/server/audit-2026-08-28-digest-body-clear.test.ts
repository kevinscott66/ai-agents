/**
 * Аудит 2026-08-28: тело статьи нельзя было очистить.
 *
 * `upsertDigest` с аудита 2026-08-21 различает «поле не прислали» (NULL — не
 * трогаем сохранённое) и «прислали пустую строку» (явная очистка). Докстринг
 * там так и написан: «явную очистку никто не отнял».
 *
 * Только до неё не доходило. Обработчик собирал `...(articleBody ? {body} : {})`,
 * то есть пустую строку ВЫБРАСЫВАЛ наравне с отсутствием поля — `$body`
 * оказывался null, и старое тело оставалось на месте. Убрать ошибочно
 * опубликованный полный текст (черновик, чужая цитата, лишний абзац) было
 * нечем: DELETE-роута у дайджестов нет, а перезалив с `body: ""` возвращал
 * `ok:true` и ничего не менял.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-body-clear-"));
process.env.SITE_DB_PATH = join(TMP, "body.db");
process.env.SITE_INGEST_TOKEN = "body-clear-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");
const { getDigest } = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

const BODY = "# Заголовок\n\nПолный текст статьи.";

async function ingest(body: unknown): Promise<string> {
  const r = await fetch(`${base}/api/internal/digests`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer body-clear-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { id: string }).id;
}

async function seed(id: string): Promise<void> {
  await ingest({ id, title: `Статья ${id}`, summary: "аннотация", body: BODY, items: [] });
  expect(getDigest(id)?.body).toBe(BODY);
}

describe("пустая строка очищает тело", () => {
  test("body: \"\" убирает опубликованный текст", async () => {
    await seed("c-empty");
    await ingest({ id: "c-empty", title: "Статья c-empty", summary: "аннотация", body: "" });
    // Пустое тело читается как отсутствующее — `body` в Digest необязателен,
    // и rowToDigest пустую строку не отдаёт. Важно, что старого текста нет.
    expect(getDigest("c-empty")?.body).toBeUndefined();
  });

  test("строка из одних пробелов — тоже очистка", async () => {
    await seed("c-space");
    await ingest({ id: "c-space", title: "Статья c-space", summary: "аннотация", body: "   " });
    expect(getDigest("c-space")?.body).toBeUndefined();
  });
});

describe("прежние правила остались", () => {
  test("отсутствие поля не трогает сохранённое", async () => {
    await seed("k-absent");
    await ingest({ id: "k-absent", title: "Статья k-absent", summary: "новая аннотация" });
    expect(getDigest("k-absent")?.body).toBe(BODY);
  });

  test("не-строка считается «не прислали», а не очисткой", async () => {
    await seed("k-num");
    await ingest({ id: "k-num", title: "Статья k-num", summary: "аннотация", body: 42 });
    expect(getDigest("k-num")?.body).toBe(BODY);
  });

  test("новый текст по-прежнему заменяет старый", async () => {
    await seed("k-new");
    await ingest({ id: "k-new", title: "Статья k-new", summary: "аннотация", body: "Другой текст" });
    expect(getDigest("k-new")?.body).toBe("Другой текст");
  });

  test("первая публикация без body даёт пустое тело, а не падение", async () => {
    const id = await ingest({ id: "k-first", title: "Статья k-first", summary: "аннотация" });
    expect(getDigest(id)).not.toBeNull();
    expect(getDigest(id)?.body).toBeUndefined();
  });
});
