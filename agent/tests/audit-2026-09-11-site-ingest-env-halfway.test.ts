/**
 * Аудит 2026-09-11: мост на сайт считал себя настроенным на полпути.
 *
 * `ingestDigestToSite` читал `process.env.SITE_INGEST_URL` и `..._TOKEN` как
 * есть и выключался проверкой `!url || !token`. Пустую строку она ловит, а
 * значение из одних пробелов — нет: оно истинно. Дальше POST уходит по адресу
 * с пробелом, `fetch` бросает, и ветка catch раскладывает это как сетевой сбой
 * — неотличимо от «сайт не ответил».
 *
 * Тот же разбор уже записан в lib/delabs-env.ts: `EnvironmentFile=` для строки
 * `KEY=` кладёт пустую строку, а адрес без схемы даёт относительный fetch,
 * который бросает. Там знание собрали в одном месте на трёх читателей; здесь
 * читатель один, но правило то же — и принадлежит оно тому, кто настройку
 * читает, а не тому, кто по ней ходит в сеть.
 *
 * Инвариант: мост либо настроен полностью и годным адресом, либо выключен.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { siteIngestConfig } from "../lib/site-ingest.ts";

const VARS = ["SITE_INGEST_URL", "SITE_INGEST_TOKEN"] as const;
const saved = new Map<string, string | undefined>(VARS.map((v) => [v, process.env[v]]));

afterEach(() => {
  // Без восстановления env течёт в соседние файлы: bun гоняет каталог одним
  // процессом (CLAUDE.md §3.8 п.7).
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function set(url: string | undefined, token: string | undefined): void {
  if (url === undefined) delete process.env.SITE_INGEST_URL;
  else process.env.SITE_INGEST_URL = url;
  if (token === undefined) delete process.env.SITE_INGEST_TOKEN;
  else process.env.SITE_INGEST_TOKEN = token;
}

describe("предпосылка: пробел — не пустая строка", () => {
  test("строка из пробелов истинна, и `!x` её не ловит", () => {
    expect(Boolean(" ")).toBe(true);
    expect(" ".trim() || "").toBe("");
  });
});

describe("siteIngestConfig", () => {
  test("обе переменные заданы — мост включён", () => {
    set("https://example.invalid/api/ingest", "t0ken");
    expect(siteIngestConfig()).toEqual({
      url: "https://example.invalid/api/ingest",
      token: "t0ken",
    });
  });

  test("хвостовые пробелы срезаются, а не уезжают в адрес и заголовок", () => {
    set("  https://example.invalid/api/ingest  ", "  t0ken\t");
    expect(siteIngestConfig()).toEqual({
      url: "https://example.invalid/api/ingest",
      token: "t0ken",
    });
  });

  test("адрес из одних пробелов выключает мост, а не ломает fetch", () => {
    set("   ", "t0ken");
    expect(siteIngestConfig()).toBeNull();
  });

  test("токен из одних пробелов выключает мост", () => {
    set("https://example.invalid/api/ingest", "   ");
    expect(siteIngestConfig()).toBeNull();
  });

  test("пустые строки по-прежнему выключают мост", () => {
    set("", "");
    expect(siteIngestConfig()).toBeNull();
  });

  test("переменных нет вовсе — мост выключен", () => {
    set(undefined, undefined);
    expect(siteIngestConfig()).toBeNull();
  });

  test("адрес без схемы — мост выключен, а не относительный fetch", () => {
    set("delabs.space/api/ingest", "t0ken");
    expect(siteIngestConfig()).toBeNull();
  });

  test("схема сравнивается без учёта регистра", () => {
    set("HTTPS://example.invalid/api/ingest", "t0ken");
    expect(siteIngestConfig()?.url).toBe("HTTPS://example.invalid/api/ingest");
  });
});
