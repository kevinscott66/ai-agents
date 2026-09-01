/**
 * Аудит 2026-08-28: «не читаем поток, пока не уверены» — проверка стояла после чтения.
 *
 * В `applyCompressionAndEtag` над телом комментарий обещает: поток статики не
 * буферизуем, пока не убедились, что это JSON/HTML/текст. Но `isText`
 * вычислялся до буферизации, а ПРИМЕНЯЛСЯ только ниже — в условиях ETag и
 * gzip. Для нетекстового ответа (webp, woff2, ico, wasm, octet-stream) ни того,
 * ни другого не делается вовсе, то есть `await resp.arrayBuffer()` втягивал
 * файл целиком в память ради ответа, байт в байт равного исходному.
 *
 * Ровно тот же промах, что уже чинили этажом ниже у GZIP_MAX_BYTES: фильтр
 * стоит после работы, которую он был обязан отменить. Поток здесь один и общий
 * с SQLite, а `serveStatic` отдаёт `Bun.file` — ленивый источник, который до
 * этого момента ничего с диска не читал.
 */
import { describe, test, expect } from "bun:test";
import { applyCompressionAndEtag } from "../lib/http-utils.ts";

/**
 * Ответ с ленивым телом: `highWaterMark: 0` — иначе поток набивает очередь сам
 * и `pull` срабатывает без единого читателя, то есть счётчик врал бы.
 */
function lazyResp(
  bytes: number,
  type: string,
  extraHeaders: Record<string, string> = {},
): { resp: Response; pulls: () => number } {
  let pulls = 0;
  const resp = new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls += 1;
          c.enqueue(new Uint8Array(bytes).fill(7));
          c.close();
        },
      },
      { highWaterMark: 0 },
    ),
    {
      status: 200,
      headers: {
        "content-type": type,
        "content-length": String(bytes),
        ...extraHeaders,
      },
    },
  );
  return { resp, pulls: () => pulls };
}

function textResp(bytes: number, type = "application/json"): Response {
  const body = "x".repeat(bytes);
  return new Response(body, {
    status: 200,
    headers: { "content-type": type, "content-length": String(bytes) },
  });
}

function getReq(headers: Record<string, string> = {}): Request {
  return new Request("http://t/logo.webp", {
    method: "GET",
    headers: { "accept-encoding": "gzip", ...headers },
  });
}

describe("нетекстовое тело не буферизуется", () => {
  test("картинка в границе размера проходит нетронутой", async () => {
    const { resp, pulls } = lazyResp(50_000, "image/webp");
    const out = await applyCompressionAndEtag(getReq(), resp);
    expect(out).toBe(resp);
    expect(resp.bodyUsed).toBe(false);
    expect(pulls()).toBe(0);
  });

  test("шрифт, иконка, wasm и octet-stream — так же", async () => {
    for (const type of [
      "font/woff2",
      "image/x-icon",
      "application/wasm",
      "application/octet-stream",
      "image/png",
    ]) {
      const { resp, pulls } = lazyResp(50_000, type);
      const out = await applyCompressionAndEtag(getReq(), resp);
      expect(out).toBe(resp);
      expect(pulls()).toBe(0);
    }
  });

  test("тело всё ещё доезжает целиком, заголовки на месте", async () => {
    const { resp } = lazyResp(4096, "image/webp", {
      "cache-control": "public, max-age=31536000, immutable",
    });
    const out = await applyCompressionAndEtag(getReq(), resp);
    expect(out.headers.get("content-type")).toBe("image/webp");
    expect(out.headers.get("content-length")).toBe("4096");
    expect(out.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect((await out.arrayBuffer()).byteLength).toBe(4096);
  });

  test("нетекстовое тело без content-length тоже не читается", async () => {
    // Chunked-ветка: раньше именно она буферизовала безусловно.
    let pulls = 0;
    const resp = new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(c) {
            pulls += 1;
            c.enqueue(new Uint8Array(1024));
            c.close();
          },
        },
        { highWaterMark: 0 },
      ),
      { status: 200, headers: { "content-type": "image/webp" } },
    );
    expect(resp.headers.get("content-length")).toBeNull();
    const out = await applyCompressionAndEtag(getReq(), resp);
    expect(out).toBe(resp);
    expect(pulls).toBe(0);
  });

  test("нетекстовый ответ не получает ни ETag, ни gzip", async () => {
    // Контроль смысла: пропуск обязан быть пропуском, а не тихой потерей
    // заголовков, которые раньше проставлялись.
    const { resp } = lazyResp(50_000, "image/webp");
    const out = await applyCompressionAndEtag(getReq(), resp);
    expect(out.headers.get("etag")).toBeNull();
    expect(out.headers.get("content-encoding")).toBeNull();
  });
});

describe("текстовое тело обрабатывается как раньше", () => {
  test("JSON получает ETag и gzip", async () => {
    const out = await applyCompressionAndEtag(getReq(), textResp(50_000));
    expect(out.headers.get("etag")).toMatch(/^W\//);
    expect(out.headers.get("content-encoding")).toBe("gzip");
  });

  test("css, javascript, html и xml остаются текстом", async () => {
    for (const type of [
      "text/css; charset=utf-8",
      "text/javascript; charset=utf-8",
      "text/html; charset=utf-8",
      "application/xml",
    ]) {
      const out = await applyCompressionAndEtag(getReq(), textResp(50_000, type));
      expect(out.headers.get("etag")).toMatch(/^W\//);
    }
  });

  test("If-None-Match по-прежнему отдаёт 304", async () => {
    const first = await applyCompressionAndEtag(getReq(), textResp(50_000));
    const etag = first.headers.get("etag")!;
    const second = await applyCompressionAndEtag(
      getReq({ "if-none-match": etag }),
      textResp(50_000),
    );
    expect(second.status).toBe(304);
  });
});
