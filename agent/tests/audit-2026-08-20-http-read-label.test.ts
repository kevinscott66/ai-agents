/**
 * Аудит 2026-08-20: докблок lib/http.ts обещает «uniform transport-error
 * messages (label-prefixed)», и все ветки его держат — кроме одной.
 *
 * `AbortSignal.timeout(timeoutMs)` снимает не только установку соединения, но
 * и чтение тела. Апстрим, который отдал заголовки и замолчал на середине,
 * ронял наружу голый `TimeoutError: The operation timed out.` — мимо обоих
 * catch'ей fetchJson. Через хелпер ходят figma, github и tgstat, так что по
 * такому сообщению оператор не мог сказать даже, чей апстрим встал.
 *
 * Отдельная забота теста — не поломать при этом сообщение о переполнении:
 * оно уже с label, и наивная обёртка приписала бы второй префикс.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { fetchJson } from "../lib/http.ts";

/** Отдаёт заголовки и первый кусок, дальше молчит навсегда. */
function stallingBody(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('{"data":"'));
      // close() не вызываем: ровно так выглядит зависший апстрим.
    },
  });
}

/** ~2 MB потоком без Content-Length — путь, на котором срабатывает наш потолок. */
function bigBody(): ReadableStream<Uint8Array> {
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
      if (p === "/stall") return new Response(stallingBody(), { headers: json });
      if (p === "/big") return new Response(bigBody(), { headers: json });
      return new Response('{"ok":true}', { headers: json });
    },
  });
  base = `http://127.0.0.1:${srv.port}`;
});

afterAll(() => srv?.stop(true));

describe("audit-2026-08-20 / fetchJson: обрыв чтения тела тоже с label", () => {
  test("таймаут посреди тела → в сообщении есть label", async () => {
    const err = await failOf(
      fetchJson(`${base}/stall`, { label: "figma", timeoutMs: 300 }),
    );
    expect(err.message).toContain("figma");
  });

  test("сообщение не голый TimeoutError — видно, что это чтение ответа", async () => {
    const err = await failOf(
      fetchJson(`${base}/stall`, { label: "tgstat", timeoutMs: 300 }),
    );
    expect(err.message).toMatch(/^tgstat response read failed:/);
    expect(err.message).toMatch(/tim(ed )?out/i);
  });

  test("label не теряется и при другом апстриме — различить можно", async () => {
    const a = await failOf(
      fetchJson(`${base}/stall`, { label: "github", timeoutMs: 300 }),
    );
    const b = await failOf(
      fetchJson(`${base}/stall`, { label: "figma", timeoutMs: 300 }),
    );
    expect(a.message).not.toBe(b.message);
    expect(a.message).toContain("github");
    expect(b.message).toContain("figma");
  });

  test("переполнение потолка не получает второй префикс", async () => {
    const err = await failOf(
      fetchJson(`${base}/big`, { label: "figma", maxBytes: 100_000 }),
    );
    expect(err.message).toMatch(/too large/i);
    // Было бы «figma response read failed: figma response too large (...)».
    expect(err.message).not.toMatch(/read failed/);
    expect(err.message.match(/figma/g)).toHaveLength(1);
  });

  test("успешный ответ по-прежнему разбирается", async () => {
    const r = await fetchJson<{ ok: boolean }>(`${base}/ok`, { label: "probe" });
    expect(r).toEqual({ ok: true });
  });
});
