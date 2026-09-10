/**
 * Аудит 2026-09-11: прикладной потолок ингеста был перекрыт транспортным.
 *
 * `maxRequestBodySize` в боевом `Bun.serve` стоял ровно `1 << 20` — в точности
 * `MAX_INGEST_BYTES`. Тело в CAP+1 байт Bun отбивает сам, ДО хендлера: `413` с
 * единственным заголовком `connection: close`. Значит ветка
 * `size > MAX_INGEST_BYTES` в `readCappedBody` и ответ
 * `{ error: "payload_too_large" }` в `authedJsonBody` в бою недостижимы, агент
 * получает пустое тело вместо контракта `{error}`, которым пользуется на всех
 * прочих ошибках ингеста, и ни одного заголовка из `SECURITY_HEADERS`.
 *
 * Почему это не поймал `audit-2026-08-13.test.ts:306`, который проверяет
 * ровно `payload_too_large`: он поднимает `Bun.serve({ port: 0, fetch })` без
 * `maxRequestBodySize`, то есть с дефолтом Bun в 128 МБ. Транспортный слой в
 * нём не участвует, и коллизия двух потолков ему не видна. Здесь сервер
 * поднимается с БОЕВЫМ значением — потому файл и заводится отдельным.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-audit0911cap-"));
process.env.SITE_DB_PATH = join(TMP, "cap.db");

const { makeFetchHandler, MAX_INGEST_BYTES, MAX_REQUEST_BODY_BYTES } =
  await import("./index.ts");

const TOKEN = "s3cret-ingest-token-cap-0911";
const PREV_TOKEN = process.env.SITE_INGEST_TOKEN;
const PREV_DB = process.env.SITE_DB_PATH;

let server: ReturnType<typeof Bun.serve>;
let base: string;

/** Тело нужного размера, но синтаксически валидный JSON-объект. */
function bodyOfSize(bytes: number): string {
  const head = `{"id":"cap-probe","title":"t","summary":"s","pad":"`;
  const tail = `"}`;
  return head + "x".repeat(Math.max(0, bytes - head.length - tail.length)) + tail;
}

const post = (body: string) =>
  fetch(`${base}/api/internal/digests`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body,
  });

beforeAll(() => {
  process.env.SITE_INGEST_TOKEN = TOKEN;
  // Ровно то, что стоит в боевом вызове внизу index.ts.
  server = Bun.serve({
    port: 0,
    fetch: makeFetchHandler(),
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
  // CLAUDE.md §3.8.7: env не течёт в соседние файлы тестов.
  if (PREV_TOKEN === undefined) delete process.env.SITE_INGEST_TOKEN;
  else process.env.SITE_INGEST_TOKEN = PREV_TOKEN;
  if (PREV_DB === undefined) delete process.env.SITE_DB_PATH;
  else process.env.SITE_DB_PATH = PREV_DB;
});

describe("потолок тела ингеста при боевых настройках сервера", () => {
  test("транспортный потолок стоит выше прикладного", () => {
    // Равенство и означало «прикладного потолка нет».
    expect(MAX_REQUEST_BODY_BYTES).toBeGreaterThan(MAX_INGEST_BYTES);
  });

  test("перебор на байт даёт контракт {error}, а не голый обрыв", async () => {
    const r = await post(bodyOfSize(MAX_INGEST_BYTES + 1));
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: "payload_too_large" });
  });

  test("отказ несёт заголовки безопасности — значит отвечал хендлер", async () => {
    const r = await post(bodyOfSize(MAX_INGEST_BYTES + 64 * 1024));
    expect(r.status).toBe(413);
    // У ответа самого Bun'а из заголовков только `connection: close`.
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.json()).toEqual({ error: "payload_too_large" });
  });

  test("честный дайджест проходит через тот же сервер", async () => {
    const r = await post(
      JSON.stringify({
        id: "cap-normal",
        title: "обычный",
        summary: "обычная аннотация",
        items: [{ text: "пункт", url: "https://a.example" }],
      }),
    );
    expect(r.status).toBe(200);
  });

  test("выше транспортного потолка тело не вычитывается вовсе", async () => {
    // Внешняя сеть безопасности остаётся: ответ голый, и это правильно —
    // такое тело незачем даже дочитывать.
    const r = await post(bodyOfSize(MAX_REQUEST_BODY_BYTES + 1));
    expect(r.status).toBe(413);
    expect(await r.text()).toBe("");
  });
});
