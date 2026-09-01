/**
 * Аудит 2026-08-11: lib/http.ts не имел ни одного теста, хотя его докблок
 * обещает «response size cap — no memory blowup before parse», а через него
 * ходят все внешние API: figma, github, tgstat.
 *
 * Лимит проверялся ТОЛЬКО по заголовку Content-Length. Ответ без него —
 * chunked / gzip / любой прокси посередине — давал `Number(null ?? 0)` → 0,
 * то есть проверка всегда проходила, а `res.json()` затягивал тело целиком в
 * память. Замер до фикса: при maxBytes = 1 MB функция вернула тело на 20 MB.
 *
 * Ветка ошибки (`!res.ok`) читала тело так же без ограничения — `res.text()`
 * буферизовал все 20 MB, чтобы взять из них первые 160 символов.
 *
 * Инвариант: столько байт, сколько разрешено, и ни байтом больше — независимо
 * от того, что о своём размере сообщил сервер.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { fetchJson } from "../lib/http.ts";

/** ~2 MB тела, отданные потоком без Content-Length. */
function chunkedBody(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('{"data":"'));
      for (let i = 0; i < 20; i++) c.enqueue(enc.encode("x".repeat(100_000)));
      c.enqueue(enc.encode('"}'));
      c.close();
    },
  });
}

/**
 * Ошибка, которой вызов отказал. Падает сам, если вызов вдруг успешен, —
 * иначе тест на «есть label в сообщении» молча проходил бы мимо.
 */
async function failOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("ожидали отказ, а вызов вернул результат");
}

let srv: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  srv = Bun.serve({
    port: 0,
    fetch(req) {
      const p = new URL(req.url).pathname;
      const json = { "content-type": "application/json" };
      if (p === "/chunked") return new Response(chunkedBody(), { headers: json });
      if (p === "/chunked-err") return new Response(chunkedBody(), { status: 500 });
      if (p === "/declared")
        return new Response(JSON.stringify({ data: "x".repeat(2_000_000) }), { headers: json });
      if (p === "/small") return new Response(JSON.stringify({ ok: true, n: 42 }), { headers: json });
      if (p === "/err-small") return new Response("нет такого ключа", { status: 404 });
      if (p === "/broken") return new Response("{не json", { headers: json });
      return new Response("{}", { headers: json });
    },
  });
  base = `http://127.0.0.1:${srv.port}`;
});

afterAll(() => srv?.stop(true));

describe("fetchJson: лимит размера держится и без Content-Length", () => {
  test("ответ без Content-Length не проходит мимо лимита", async () => {
    // Именно этот случай был дырой: сервер не объявил размер — проверки не было.
    await expect(fetchJson(`${base}/chunked`, { label: "probe", maxBytes: 100_000 })).rejects.toThrow(
      /too large/i,
    );
  });

  test("объявленный слишком большой размер по-прежнему отвергается", async () => {
    await expect(fetchJson(`${base}/declared`, { label: "probe", maxBytes: 100_000 })).rejects.toThrow(
      /too large/i,
    );
  });

  test("тело ошибки тоже не читается целиком", async () => {
    // !res.ok раньше звал res.text() без ограничения — 2 MB в память ради 160 символов.
    const err = await failOf(fetchJson(`${base}/chunked-err`, { label: "probe", maxBytes: 100_000 }));
    expect(err).toBeInstanceOf(Error);
    expect(err.message.length).toBeLessThan(400);
  });

  test("в сообщении об ошибке есть label — понятно, чей апстрим", async () => {
    const err = await failOf(fetchJson(`${base}/chunked`, { label: "tgstat", maxBytes: 100_000 }));
    expect(err.message).toContain("tgstat");
  });
});

describe("fetchJson: обычные ответы работают как раньше", () => {
  test("маленький JSON разбирается", async () => {
    const r = await fetchJson<{ ok: boolean; n: number }>(`${base}/small`, { label: "probe" });
    expect(r).toEqual({ ok: true, n: 42 });
  });

  test("ответ ровно в лимит проходит", async () => {
    const body = JSON.stringify({ ok: true, n: 42 });
    const r = await fetchJson(`${base}/small`, { label: "probe", maxBytes: body.length });
    expect(r).toEqual({ ok: true, n: 42 });
  });

  test("HTTP-ошибка отдаёт статус и кусок тела", async () => {
    const err = await failOf(fetchJson(`${base}/err-small`, { label: "probe" }));
    expect(err.message).toContain("404");
    expect(err.message).toContain("нет такого ключа");
  });

  test("битый JSON — ошибка с label, а не голый SyntaxError", async () => {
    const err = await failOf(fetchJson(`${base}/broken`, { label: "figma" }));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("figma");
  });

  test("недоступный хост — ошибка с label", async () => {
    const err = await failOf(fetchJson("http://127.0.0.1:1/nope", { label: "figma", timeoutMs: 2000 }));
    expect(err.message).toContain("figma");
  });
});
