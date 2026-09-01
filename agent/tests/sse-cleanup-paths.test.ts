/**
 * У SSE-соединения уборка висела на одной ниточке (аудит 2026-08-04).
 *
 * Каждое соединение — слушатель в глобальном Set шины, 25-секундный интервал и
 * единица в счётчике соединений пользователя. Снять всё это мог только
 * `req.signal`. Если он не сработает — сборка рантайма без сигнала, обрыв не
 * клиентом, а прокси, — подписка живёт до рестарта процесса: на каждом действии
 * агента emit() синхронно сериализует payload в мёртвый поток, а пользователь
 * навсегда упирается в потолок 5 соединений и получает "too_many_streams"
 * вместо живых обновлений в Mini App.
 *
 * Теперь ту же уборку зовут ещё два события: `cancel()` потока (рантайм говорит
 * об отвалившемся читателе даже без abort-сигнала) и первая же неудачная запись
 * (писать в закрытый поток можно только в никуда). Через реальный HTTP
 * дотянуться до этих двух путей нельзя — клиентский abort всегда поднимает
 * сигнал первым, — поэтому они закреплены структурно, а поведенческий тест
 * стережёт цикл целиком.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_sse_cleanup";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { sseUrl } from "./_sse.ts";
import { readFileSync } from "node:fs";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { _listenerCount } from "../lib/events-bus.ts";

const BOT_TOKEN = "test_bot_token_for_sse_cleanup";
const USER_ID = 771177;
const SSE_MAX_PER_USER = 5; // зеркалит константу в miniapp-server.ts

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    adminUserIds: [USER_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
});

function initData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "q-sse-cleanup",
    user: JSON.stringify({ id: USER_ID, username: "s", first_name: "S" }),
  });
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("соединение не оставляет следов", () => {
  test("открыть и оборвать больше, чем потолок — каждый раз 200", async () => {
    const baseline = _listenerCount();

    // Вдвое больше потолка: если счётчик не убывает, шестой заход упрётся в
    // 429 "too_many_streams" — ровно то, что видел бы пользователь.
    for (let i = 0; i < SSE_MAX_PER_USER * 2 + 2; i++) {
      const ac = new AbortController();
      const resp = await fetch(
        await sseUrl(base, initData()),
        { signal: ac.signal },
      );
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toContain("text/event-stream");

      // Дождаться первой записи: значит слушатель уже в Set'е и уборке есть
      // что убирать.
      const reader = resp.body!.getReader();
      await reader.read();
      await waitFor(() => _listenerCount() > baseline);
      expect(_listenerCount()).toBeGreaterThan(baseline);

      ac.abort();
      await waitFor(() => _listenerCount() === baseline);
      expect(_listenerCount()).toBe(baseline);
    }
  });
});

describe("уборку зовёт не только abort", () => {
  const SRC = readFileSync(
    new URL("../lib/miniapp-server.ts", import.meta.url),
    "utf8",
  );
  const sse = SRC.slice(SRC.indexOf('path === "/api/events"'));
  const block = sse.slice(0, sse.indexOf("text/event-stream"));

  // Пины ниже смотрят на исходный текст, поэтому меряют и комментарии тоже.
  // 2026-08-20: абзац документации внутри catch развёл `catch` и `cleanup()`
  // больше чем на 500 символов, и пин упал на коде, который не менялся. Окно
  // должно мерить код, а не объём объяснений к нему.
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  test("cancel() потока делает уборку", () => {
    // Мутационная проверка: с `cancel(){}` без вызова этот пин падает.
    expect(stripComments(block)).toMatch(/cancel\(\)\s*\{[\s\S]{0,300}?cleanup\(\)/);
  });

  test("cleanup живёт вне start(), иначе cancel() до него не дотянется", () => {
    expect(block.indexOf("let cleanup")).toBeLessThan(
      block.indexOf("new ReadableStream"),
    );
  });

  test("провал записи снимает подписку, а не только пишет в debug", () => {
    const enq = block.slice(block.indexOf("const safeEnqueue"));
    const body = stripComments(enq.slice(0, enq.indexOf("busSubscribe")));
    expect(body).toMatch(/catch[\s\S]{0,500}cleanup\(\)/);
  });

  test("первая запись идёт после сборки уборки", () => {
    // Иначе её провал попадёт в заглушку, а единица в счётчике соединений
    // останется висеть.
    expect(block.indexOf("cleanup = () =>")).toBeLessThan(
      block.indexOf(":ok"),
    );
  });
});
