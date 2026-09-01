/**
 * Аудит 2026-08-28: два потолка на чтение чужого тела держались не так, как
 * обещали их же докблоки.
 *
 * 1. `lib/http.ts` — потолки по размеру ограничивали память, но не передачу.
 *    Отказ по Content-Length бросал исключение, не тронув `res.body`, а
 *    переполнение внутри чтения обрывалось через `reader.cancel()`. Замер на
 *    локальном сервере, отдающем ответ на 500 МБ, через 400 мс после отказа:
 *    без ничего 20.2 МБ ушло по проводу, после `cancel()` — 18.6 МБ, сокет
 *    жив в обоих случаях. bun дочитывает брошенное тело, чтобы переиспользовать
 *    соединение. Останавливает это только abort самого запроса: 0 байт и
 *    закрытый сокет. То есть апстрим, объявивший гигабайт, качался в фоне до
 *    истечения десятисекундного таймаута — при том, что вызывающий уже получил
 *    отказ.
 *
 * 2. `lib/errors.ts` — «Потолок на ЧТЕНИЕ тела вендорской ошибки — 64 КБ»,
 *    но цикл `while (total < MAX)` сначала дочитывает очередной кусок и только
 *    потом сверяется. Фактический потолок — «64 КБ плюс один кусок», а кусок
 *    задаёт апстрим. Разбор ниже всё равно режет до 300 символов, поэтому
 *    видимого следа не было — потолок просто не был тем числом, что написано.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { fetchJson } from "../lib/http.ts";
import { MAX_VENDOR_BODY_BYTES, _readVendorBodyCapped, vendorErrorDetail } from "../lib/errors.ts";

const servers: http.Server[] = [];
// bun гоняет весь каталог одним процессом: оставленный setInterval пишет в
// мёртвый сокет до конца прогона. Гасим явно.
const timers: ReturnType<typeof setInterval>[] = [];

async function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

afterAll(() => {
  for (const t of timers) clearInterval(t);
  for (const s of servers) {
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    s.close();
  }
});

/** Сервер, который льёт тело порциями, пока его не оборвут. */
async function flooder(headers: Record<string, string>): Promise<{
  port: number;
  socket: () => import("node:net").Socket | undefined;
}> {
  let sock: import("node:net").Socket | undefined;
  const port = await listen((req, res) => {
    sock = req.socket;
    res.on("error", () => {});
    res.writeHead(200, headers);
    const t = setInterval(() => {
      if (res.destroyed || res.writableEnded || res.socket === null) {
        clearInterval(t);
        return;
      }
      res.write("x".repeat(64 * 1024));
    }, 1);
    timers.push(t);
  });
  return { port, socket: () => sock };
}

describe("fetchJson: отказ по размеру снимает запрос", () => {
  test("отказ по Content-Length рвёт соединение, а не качает отвергнутое тело", async () => {
    const { port, socket } = await flooder({
      "content-type": "application/json",
      "content-length": "500000000",
    });

    await expect(
      fetchJson(`http://127.0.0.1:${port}/`, { label: "probe", maxBytes: 1000 }),
    ).rejects.toThrow("probe response too large (500000000 bytes)");

    // Разрыв асинхронный: даём ему круг событий. 200 мс против 10 с таймаута —
    // разница между «отпустили» и «качаем до конца».
    await new Promise((r) => setTimeout(r, 200));
    expect(socket()?.destroyed).toBe(true);
  });

  test("переполнение при чтении (без Content-Length) тоже рвёт соединение", async () => {
    // Chunked: заголовка с размером нет вовсе, лимит срабатывает уже в потоке.
    const { port, socket } = await flooder({ "content-type": "application/json" });

    await expect(
      fetchJson(`http://127.0.0.1:${port}/`, { label: "probe", maxBytes: 1000 }),
    ).rejects.toThrow("probe response too large (> 1000 bytes)");

    await new Promise((r) => setTimeout(r, 200));
    expect(socket()?.destroyed).toBe(true);
  });

  test("ответ в пределах лимита по-прежнему разбирается", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const got = await fetchJson<{ ok: boolean }>(`http://127.0.0.1:${port}/`, {
      label: "probe",
    });
    expect(got).toEqual({ ok: true });
  });
});

describe("readVendorBodyCapped: потолок ровно 64 КБ", () => {
  function chunked(chunkBytes: number, chunks: number): { res: Response; pulled: () => number } {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled >= chunks) {
          c.close();
          return;
        }
        pulled += 1;
        c.enqueue(new Uint8Array(chunkBytes).fill(0x61)); // 'a'
      },
    });
    return { res: new Response(stream, { status: 500 }), pulled: () => pulled };
  }

  test("длинное тело обрезается ровно на потолке, а не на потолке плюс кусок", async () => {
    const { res } = chunked(16 * 1024, 40);
    const body = await _readVendorBodyCapped(res);
    // ASCII: один символ — один байт.
    expect(body.length).toBe(MAX_VENDOR_BODY_BYTES);
  });

  test("лишние куски у апстрима не запрашиваются", async () => {
    const { res, pulled } = chunked(16 * 1024, 40);
    await _readVendorBodyCapped(res);
    // 64000 / 16384 = 3.9 — четвёртого куска хватает, пятый уже лишний.
    expect(pulled()).toBeLessThanOrEqual(4);
  });

  test("короткое тело доходит целиком", async () => {
    const res = new Response('{"error":{"message":"nope"}}', { status: 400 });
    expect(await _readVendorBodyCapped(res)).toBe('{"error":{"message":"nope"}}');
  });

  test("рез посреди многобайтового символа не роняет чтение", async () => {
    // Кусок в 1 байт: рез гарантированно приходится на середину «ы».
    const bytes = new TextEncoder().encode("ы".repeat(MAX_VENDOR_BODY_BYTES));
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= bytes.length) {
          c.close();
          return;
        }
        c.enqueue(bytes.subarray(i, i + 1024));
        i += 1024;
      },
    });
    const body = await _readVendorBodyCapped(new Response(stream, { status: 500 }));
    // Половина суррогата не должна давать исключение; хвост — U+FFFD, и это
    // ожидаемо: дальше строку всё равно режут до 300 символов.
    expect(body.length).toBeGreaterThan(0);
    expect(body.startsWith("ы")).toBe(true);
  });

  test("пояснение вендора из усечённого тела по-прежнему достаётся", async () => {
    const filler = " ".repeat(80_000);
    const res = new Response(`{"error":{"message":"rate limited"}}${filler}`, { status: 429 });
    expect(await vendorErrorDetail(res)).toBe("rate limited");
  });
});
