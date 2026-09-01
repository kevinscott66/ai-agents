/**
 * Аудит 2026-08-28: нетекстовое тело дочитывалось целиком, чтобы быть выброшенным.
 *
 * Фильтр по content-type стоял на границе форматирования, то есть уже ПОСЛЕ
 * загрузки: pinnedRequest собирал до MAX_RESPONSE_BYTES (5 МБ) чужого PDF в
 * память и в сокет, а formatFetchedPage отвечал строчкой «тип не текстовый».
 * Тип при этом известен в колбэке ответа, до первого байта тела.
 *
 * Проверяем расход, а не только текст ответа: сервер отдаёт тело порциями по
 * таймеру и считает отданное. До правки клиент дочитывал все порции; после —
 * рвёт соединение на заголовках, и сервер останавливается на первых.
 */
import { afterAll, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { pinnedRequest } from "../lib/sdk-web-guard.ts";

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

const CHUNK = "x".repeat(16 * 1024);
const CHUNKS = 40;

test("нетекстовый ответ обрывается, не дочитывая тело", async () => {
  let sent = 0;
  const port = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.on("error", () => {});
    const t = setInterval(() => {
      const dead =
        res.destroyed || res.writableEnded || res.socket === null || res.socket.destroyed;
      if (dead || sent >= CHUNKS) {
        clearInterval(t);
        if (!dead) res.end();
        return;
      }
      sent += 1;
      res.write(CHUNK);
    }, 5);
    timers.push(t);
  });

  const out = await pinnedRequest(new URL(`http://example.test:${port}/f.pdf`), "127.0.0.1");
  expect(out.status).toBe(200);
  expect(out.body).toBe("");
  expect(out.headers["content-type"]).toBe("application/pdf");

  // Разрыв асинхронный — пара порций могла уйти. Важно, что не все сорок:
  // до правки клиент читал их до конца.
  await new Promise((r) => setTimeout(r, 120));
  expect(sent).toBeLessThan(CHUNKS / 2);
});

test("текстовый ответ читается целиком, как и раньше", async () => {
  const port = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("тело целиком");
  });
  const out = await pinnedRequest(new URL(`http://example.test:${port}/`), "127.0.0.1");
  expect(out.body).toBe("тело целиком");
});

test("ответ без content-type читается целиком", async () => {
  const port = await listen((_req, res) => {
    res.removeHeader("content-type");
    res.writeHead(200);
    res.end("без типа");
  });
  const out = await pinnedRequest(new URL(`http://example.test:${port}/`), "127.0.0.1");
  expect(out.body).toBe("без типа");
});

test("редирект не обрывается по типу своего тела — из него читается Location", async () => {
  const port = await listen((_req, res) => {
    res.writeHead(302, {
      location: "https://example.test/next",
      "content-type": "application/octet-stream",
    });
    res.end("тело редиректа");
  });
  const out = await pinnedRequest(new URL(`http://example.test:${port}/`), "127.0.0.1");
  expect(out.status).toBe(302);
  expect(out.headers.location).toBe("https://example.test/next");
});
