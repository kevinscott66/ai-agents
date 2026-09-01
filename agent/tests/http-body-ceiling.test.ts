/**
 * Потолок пост-обработки тела ответа (повторный аудит 2026-08-04).
 *
 * applyCompressionAndEtag делает над телом три вещи, каждая из которых
 * синхронно проходит по нему целиком или копирует его: arrayBuffer(),
 * Bun.hash() для ETag и gzipSync(). Поток при этом один — он же обслуживает
 * SQLite. Граница GZIP_MAX_BYTES заводилась именно под это, но проверялась
 * только у gzipSync: тело на 10 МБ по-прежнему буферизовалось и хешировалось,
 * просто не сжималось. То есть отказ от gzip экономил третий проход из трёх.
 */
import { describe, test, expect } from "bun:test";
import { applyCompressionAndEtag } from "../lib/http-utils.ts";

const MAX = 2_000_000;

/**
 * Ответ с объявленным Content-Length — так его отдают и json(), и serveStatic
 * (Bun сам заголовок в конструкторе Response не ставит, поэтому оба ставят
 * его явно; без него потолок срабатывал бы уже после буферизации).
 */
function jsonResp(bytes: number, extraHeaders: Record<string, string> = {}) {
  const body = "x".repeat(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-length": String(bytes),
      ...extraHeaders,
    },
  });
}

function getReq(headers: Record<string, string> = {}): Request {
  return new Request("http://t/api/actions", {
    method: "GET",
    headers: { "accept-encoding": "gzip", ...headers },
  });
}

describe("тело сверх границы не хешируется и не жмётся", () => {
  test("объявленный content-length сверх границы → ответ проходит нетронутым", async () => {
    const resp = jsonResp(MAX + 1);
    const out = await applyCompressionAndEtag(getReq(), resp);
    // Тот же самый объект: тело даже не буферизовали.
    expect(out).toBe(resp);
    expect(out.headers.get("etag")).toBeNull();
    expect(out.headers.get("content-encoding")).toBeNull();
  });

  test("нет content-length (chunked) → без ETag и без gzip", async () => {
    // Поток без объявленной длины отменить нельзя — он уже в памяти к моменту,
    // когда размер известен. Но синхронные хеш и сжатие всё равно не делаем.
    const big = "x".repeat(MAX + 1);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    const resp = new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    expect(resp.headers.get("content-length")).toBeNull();
    const out = await applyCompressionAndEtag(getReq(), resp);
    expect(out.headers.get("etag")).toBeNull();
    expect(out.headers.get("content-encoding")).toBeNull();
    expect((await out.text()).length).toBe(MAX + 1);
  });

  test("тело в границе обрабатывается как раньше — ETag и gzip на месте", async () => {
    // Контроль: без него «сверх границы ничего не делаем» прошло бы и при
    // полностью отключённой пост-обработке.
    const out = await applyCompressionAndEtag(getReq(), jsonResp(50_000));
    expect(out.headers.get("etag")).toMatch(/^W\//);
    expect(out.headers.get("content-encoding")).toBe("gzip");
  });

  test("If-None-Match по-прежнему отдаёт 304", async () => {
    const first = await applyCompressionAndEtag(getReq(), jsonResp(50_000));
    const etag = first.headers.get("etag")!;
    const second = await applyCompressionAndEtag(
      getReq({ "if-none-match": etag }),
      jsonResp(50_000),
    );
    expect(second.status).toBe(304);
  });

  test("ровно на границе тело ещё обрабатывается", async () => {
    // Граница включающая (`> MAX`), а не исключающая: смена на `>=` тихо
    // отрезала бы ровно-двухмегабайтный ответ.
    const out = await applyCompressionAndEtag(getReq(), jsonResp(MAX));
    expect(out.headers.get("etag")).toMatch(/^W\//);
  });
});
