/**
 * Аудит 2026-08-28: у запроса к Anthropic не было своего таймаута.
 *
 * `createAnthropic` передавал только `{ apiKey, maxRetries: 0 }`. Дефолт SDK
 * 0.98.1 — десять минут (`client.js:791`,
 * `BaseAnthropic.DEFAULT_TIMEOUT = 600000`). Слот конкурентности берётся ДО
 * запроса (`acquire()`) и отпускается только в `finally`, то есть висит всю
 * эту вилку целиком: три зависших сокета при дефолтных трёх слотах — и вся
 * команда из 12 ролей молчит десять минут, без единой строки в логе.
 *
 * Стандарт у модуля записан рядом, в докблоке TRANSIENT_MAX_RETRIES: держать
 * слот МИНУТУ на упавшей сети там уже названо неприемлемым.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import Anthropic, { APIConnectionError } from "@anthropic-ai/sdk";
import {
  createAnthropic,
  isTransientFailure,
  _resolveRequestTimeout,
  MIN_REQUEST_TIMEOUT_MS,
  MAX_REQUEST_TIMEOUT_MS,
} from "../lib/anthropic-client.ts";

const VAR = "ANTHROPIC_REQUEST_TIMEOUT_MS";
const prevTimeout = process.env[VAR];
const prevBase = process.env.ANTHROPIC_BASE_URL;

afterEach(() => {
  // Без восстановления env течёт в соседние файлы: bun гоняет каталог одним
  // процессом (CLAUDE.md §3.8 п.7).
  if (prevTimeout === undefined) delete process.env[VAR];
  else process.env[VAR] = prevTimeout;
  if (prevBase === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = prevBase;
});

const servers: http.Server[] = [];

afterAll(() => {
  for (const s of servers) {
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    s.close();
  }
});

/** Сервер, который принимает соединение и не отвечает никогда. */
async function listenSilent(): Promise<number> {
  const server = http.createServer(() => {
    /* ответа не будет — ровно тот зависший сокет, ради которого правка */
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("предпосылки", () => {
  test("без явного timeout SDK ждёт десять минут", () => {
    // Ровно то, что стояло в createAnthropic до этой правки.
    const raw = new Anthropic({ apiKey: "k", maxRetries: 0 });
    expect(raw.timeout).toBe(600_000);
  });
});

describe("createAnthropic", () => {
  test("клиент создаётся с двухминутным потолком, а не с десятиминутным", () => {
    delete process.env[VAR];
    const c = createAnthropic("k");
    expect(c.timeout).toBe(120_000);
    // Слой ретраев по-прежнему ровно один — наш.
    expect(c.maxRetries).toBe(0);
  });

  test("настройка из env доезжает до клиента", () => {
    process.env[VAR] = "45000";
    expect(createAnthropic("k").timeout).toBe(45_000);
  });

  test("мусор в env не открывает десять минут обратно", () => {
    for (const bad of ["abc", "0", "-1", "1.5", "600001", " ", ""]) {
      process.env[VAR] = bad;
      expect(createAnthropic("k").timeout).toBe(120_000);
    }
  });
});

describe("_resolveRequestTimeout", () => {
  test("отсутствие и мусор дают дефолт", () => {
    for (const bad of [undefined, "", " ", "abc", "12s", "1e3", "1.5", "-1"]) {
      expect(_resolveRequestTimeout(bad)).toBe(120_000);
    }
  });

  test("вне диапазона даёт ДЕФОЛТ, а не зажатую границу", () => {
    // Зажать 600001 в 600000 значило бы вернуть ровно ту яму, от которой ушли.
    expect(_resolveRequestTimeout(String(MIN_REQUEST_TIMEOUT_MS - 1))).toBe(120_000);
    expect(_resolveRequestTimeout(String(MAX_REQUEST_TIMEOUT_MS + 1))).toBe(120_000);
    expect(_resolveRequestTimeout("0")).toBe(120_000);
  });

  test("границы включительно, рабочие значения проходят", () => {
    expect(_resolveRequestTimeout(String(MIN_REQUEST_TIMEOUT_MS))).toBe(MIN_REQUEST_TIMEOUT_MS);
    expect(_resolveRequestTimeout(String(MAX_REQUEST_TIMEOUT_MS))).toBe(MAX_REQUEST_TIMEOUT_MS);
    expect(_resolveRequestTimeout(" 30000 ")).toBe(30_000);
  });
});

describe("зависший сокет действительно обрывается", () => {
  test("запрос к молчащему серверу падает по таймауту, а не висит", async () => {
    const port = await listenSilent();
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
    process.env[VAR] = "1000";

    const client = createAnthropic("k");
    expect(client.timeout).toBe(1000);

    const started = Date.now();
    let caught: unknown;
    try {
      await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        messages: [{ role: "user", content: "ping" }],
      });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - started;

    expect(caught).toBeInstanceOf(APIConnectionError);
    // Верхняя граница с запасом на медленную машину; важно, что это не 600000.
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  test("таймаут считается сетевым отказом — те же два ретрая, без слота", () => {
    // Классификация не меняется: APIConnectionTimeoutError — наследник
    // APIConnectionError, а `backoffWithoutSlot` спит уже без слота. То есть
    // непрерывное удержание слота ограничено сверху одним таймаутом.
    expect(isTransientFailure(new APIConnectionError({ message: "timed out" }))).toBe(true);
  });
});

describe("применение", () => {
  test("timeout передаётся в конструктор, а не остаётся дефолтом SDK", async () => {
    const src = await Bun.file(new URL("../lib/anthropic-client.ts", import.meta.url)).text();
    const i = src.indexOf("export function createAnthropic");
    const body = src.slice(i, src.indexOf("export function getAnthropic", i));
    // Аудит 2026-08-29: раньше здесь стоял дословный вызов
    // `_resolveRequestTimeout(process.env…)`. Он переехал за мемоизирующую
    // обёртку — её теперь зовут на КАЖДЫЙ запрос (пер-запросный дедлайн на
    // чтение тела), а `_resolveRequestTimeout` на кривом значении пишет
    // log.warn, и без кэша одна опечатка в .env залила бы журнал. Инвариант
    // тот же, проверяем его по цепочке, а не по одной строке.
    expect(body).toContain("timeout: _requestTimeoutMs()");
    expect(body).toContain("maxRetries: 0");

    const j = src.indexOf("export function _requestTimeoutMs");
    const resolver = src.slice(j, src.indexOf("\n}", j));
    expect(resolver).toContain("process.env.ANTHROPIC_REQUEST_TIMEOUT_MS");
    expect(resolver).toContain("_resolveRequestTimeout(raw)");
  });

  test("клиент реально уносит значение из переменной в SDK", () => {
    const saved = process.env.ANTHROPIC_REQUEST_TIMEOUT_MS;
    try {
      process.env.ANTHROPIC_REQUEST_TIMEOUT_MS = "45000";
      // Не источник, а поведение: у собранного клиента именно этот таймаут.
      expect((createAnthropic("sk-test") as { timeout?: number }).timeout).toBe(
        45_000,
      );
    } finally {
      if (saved === undefined) {
        delete process.env.ANTHROPIC_REQUEST_TIMEOUT_MS;
      } else {
        process.env.ANTHROPIC_REQUEST_TIMEOUT_MS = saved;
      }
    }
  });
});
