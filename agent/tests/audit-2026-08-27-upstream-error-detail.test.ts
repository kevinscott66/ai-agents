/**
 * Аудит 2026-08-27: три дыры в том, как в проект попадает текст чужой ошибки.
 *
 * 1. `fetchJson` на !res.ok собирал сообщение из тела апстрима БЕЗ скраббера,
 *    хотя три остальные ветки ошибок в той же функции чистятся. tgstat.ts:74
 *    кладёт токен в query, и шлюз, повторяющий URI в теле ошибки, отдавал бы
 *    его в `agent_actions.error` и в контекст модели.
 * 2. `vendorErrorDetail` читал тело целиком (`res.text()`) и резал до 300
 *    символов уже в памяти — то есть потолка на чтение не было вовсе.
 * 3. `vendorErrorDetail` на форме `{"error":"invalid_api_key"}` возвращал
 *    ПУСТО: `j.error?.message` у строки undefined, а `?? ""` это гасил.
 */
import { describe, expect, test } from "bun:test";
import { fetchJson } from "../lib/http.ts";
import { vendorErrorDetail, MAX_VENDOR_DETAIL } from "../lib/errors.ts";

/** Ответ с телом, которое отдаётся потоком; считает выданные куски. */
function streamed(
  chunks: number,
  chunkBytes: number,
  status = 500,
): { res: Response; pulled: () => number } {
  let pulled = 0;
  const piece = "x".repeat(chunkBytes);
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (pulled >= chunks) {
        c.close();
        return;
      }
      pulled++;
      c.enqueue(new TextEncoder().encode(piece));
    },
  });
  return { res: new Response(body, { status }), pulled: () => pulled };
}

describe("fetchJson: тело ошибки апстрима чистится скраббером", () => {
  test("токен из query, повторённый шлюзом в теле 500, не уезжает в исключение", async () => {
    const secret = "tgstat_live_ABCDEF1234567890";
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          `The requested URL /channels/stat?token=${secret}&channelId=1 was not found`,
          { status: 500 },
        ),
    });
    try {
      const url = `http://127.0.0.1:${server.port}/channels/stat`;
      let msg = "";
      try {
        await fetchJson(url, { label: "tgstat", timeoutMs: 3000 });
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      expect(msg).toContain("tgstat 500");
      // Главное утверждение: секрет не долетел до текста исключения.
      expect(msg).not.toContain(secret);
      expect(msg).toContain("token=");
    } finally {
      server.stop(true);
    }
  });

  test("тело без секретов доезжает как есть — скраббер не съедает пояснение", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("upstream is on fire", { status: 502 }),
    });
    try {
      let msg = "";
      try {
        await fetchJson(`http://127.0.0.1:${server.port}/x`, {
          label: "tgstat",
          timeoutMs: 3000,
        });
      } catch (e) {
        msg = e instanceof Error ? e.message : String(e);
      }
      expect(msg).toBe("tgstat 502: upstream is on fire");
    } finally {
      server.stop(true);
    }
  });
});

describe("vendorErrorDetail: строковый error и потолок на чтение", () => {
  test('{"error":"invalid_api_key"} больше не даёт пустое пояснение', async () => {
    const res = new Response(JSON.stringify({ error: "invalid_api_key" }), {
      status: 401,
    });
    expect(await vendorErrorDetail(res)).toBe("invalid_api_key");
  });

  test("объектная форма по-прежнему берёт message", async () => {
    const res = new Response(
      JSON.stringify({ error: { message: "quota exceeded", code: "q" } }),
      { status: 429 },
    );
    expect(await vendorErrorDetail(res)).toBe("quota exceeded");
  });

  test("объект без пояснения остаётся пустым, а не отдаёт сырой JSON", async () => {
    // Фикстура была `{error:{code:"q"}}`; с аудита 2026-08-28 `code` — тоже
    // пояснение (см. audit-2026-08-28-vendor-error-shapes.test.ts). Инвариант
    // «сырой JSON не подставляем» проверяется формой без носителей вовсе.
    const res = new Response(JSON.stringify({ error: { retryable: true } }), {
      status: 429,
    });
    expect(await vendorErrorDetail(res)).toBe("");
  });

  test("не-JSON тело отдаётся как пояснение", async () => {
    const res = new Response("<html>502 Bad Gateway</html>", { status: 502 });
    expect(await vendorErrorDetail(res)).toContain("502 Bad Gateway");
  });

  test("гигантское тело не вычитывается целиком: чтение обрывается на потолке", async () => {
    // 1000 кусков по 8 КБ = 8 МБ. Потолок 64 КБ → должно хватить ~8 кусков.
    const { res, pulled } = streamed(1000, 8_192);
    const detail = await vendorErrorDetail(res);
    expect(detail.length).toBeLessThanOrEqual(MAX_VENDOR_DETAIL);
    // Раньше здесь вычитывались все 1000 кусков.
    expect(pulled()).toBeLessThan(20);
  });

  test("короткое потоковое тело читается до конца", async () => {
    const { res } = streamed(2, 10);
    expect(await vendorErrorDetail(res)).toBe("x".repeat(20));
  });
});
