/**
 * Аудит 2026-08-27: pinnedRequest не исполнялся ни одним тестом.
 *
 * Все существующие тесты guardedWebFetch подставляют свой `request`, поэтому
 * колбэк `lookup`, отвечавший только старой сигнатурой `cb(null, addr, family)`,
 * ронял КАЖДЫЙ реальный запрос («results.sort is not a function») при зелёном
 * наборе: Bun и Node 20+ зовут lookup с `all: true` и ждут массив.
 *
 * Здесь поднимается настоящий http-сервер на петле и pinnedRequest зовётся
 * напрямую — единственный способ проверить пин, не подделывая его.
 */
import { test, expect, afterAll } from "bun:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { pinnedRequest, MAX_MODEL_BODY_CHARS } from "../lib/sdk-web-guard.ts";

type Server = { server: http.Server; port: number };

const servers: http.Server[] = [];
/*
 * bun гоняет ВЕСЬ каталог тестов одним процессом, поэтому «сочащийся» сервер
 * обязан быть остановлен явно: `res.on("close")` в bun после разрыва сокета
 * клиентом не приходит, и оставленный setInterval пишет в мёртвый сокет до
 * конца прогона. Замер: один такой таймер растянул полный набор с ~50 с до
 * 1157 с и уронил соседний тест по таймауту.
 */
const timers: ReturnType<typeof setInterval>[] = [];

async function listen(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<Server> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}

afterAll(() => {
  for (const t of timers) clearInterval(t);
  for (const s of servers) {
    // closeAllConnections обязателен: без него close() ждёт keep-alive сокеты
    // и прогон висит до таймаута.
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    s.close();
  }
});

test("pinnedRequest реально ходит по адресу и отдаёт тело", async () => {
  const { port } = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`ok ${req.headers.host}`);
  });
  const res = await pinnedRequest(
    new URL(`http://example.test:${port}/path?q=1`),
    "127.0.0.1",
  );
  expect(res.status).toBe(200);
  // Host остаётся исходным — пинуется только адрес соединения.
  expect(res.body).toBe(`ok example.test:${port}`);
});

test("pinnedRequest игнорирует DNS хоста: соединение идёт на validatedAddress", async () => {
  const { port } = await listen((_req, res) => {
    res.writeHead(200);
    res.end("pinned");
  });
  // Хост, которого нет в DNS. Если бы lookup не подменялся, был бы ENOTFOUND.
  const res = await pinnedRequest(
    new URL(`http://nonexistent-host-for-pin-test.invalid:${port}/`),
    "127.0.0.1",
  );
  expect(res.body).toBe("pinned");
});

test("pinnedRequest передаёт путь и query без изменений", async () => {
  let seen = "";
  const { port } = await listen((req, res) => {
    seen = req.url ?? "";
    res.writeHead(204);
    res.end();
  });
  const res = await pinnedRequest(
    new URL(`http://example.test:${port}/a/b?x=1&y=2`),
    "127.0.0.1",
  );
  expect(seen).toBe("/a/b?x=1&y=2");
  expect(res.status).toBe(204);
});

test("pinnedRequest рвёт соединение по жёсткому дедлайну, а не только по idle", async () => {
  // Сервер сочится по байту: idle-таймер (15s) сбрасывается на каждом байте,
  // и без hard-дедлайна запрос висел бы неограниченно долго.
  const { port } = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    const timer = setInterval(() => res.write("x"), 20);
    timers.push(timer);
    res.on("close", () => clearInterval(timer));
  });
  const started = Date.now();
  await expect(
    pinnedRequest(new URL(`http://example.test:${port}/`), "127.0.0.1", {
      timeoutMs: 150,
    }),
  ).rejects.toThrow(/timed out/);
  expect(Date.now() - started).toBeLessThan(5_000);
});

test("MAX_MODEL_BODY_CHARS остаётся ощутимо ниже потолка ответа", () => {
  // Страж от возврата к «отдаём модели все 5 МБ».
  expect(MAX_MODEL_BODY_CHARS).toBeLessThanOrEqual(200_000);
});
