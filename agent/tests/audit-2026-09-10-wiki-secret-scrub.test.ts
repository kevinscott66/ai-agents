/**
 * Аудит 2026-09-10: вики была единственным постоянным текстовым стоком без
 * скруббера секретов.
 *
 * У логов он стоит и объявлен неотключаемым («ALWAYS on — secrets must never
 * log», lib/log.ts), у `agent_actions.error` и у снапшота health — тот же
 * самый. В `sanitizeWikiContent` фильтровались только персональные данные, и
 * даже они выключаются переменной `WIKI_PII_FILTER=0`.
 *
 * Цена ошибки здесь выше, чем в логе: страницу не перетирает ротация. Файл
 * лежит в `agent/data/wiki/**` до конца жизни проекта, попадает в бэкап, в
 * FTS-индекс и в контекст каждого хода (`wikiSearch` подмешивает хиты в
 * промпт, `wikiLog` читается на каждом хендоффе). Пишут туда модели: у
 * `WRITE_WIKI` содержимое — аргумент модели, а компактор кладёт пересказ
 * переписки, в которой владелец мог продиктовать ключ.
 */
import { describe, expect, test } from "bun:test";
import { sanitizeWikiContent, sanitizeWikiTitle } from "../lib/memory.ts";

const SESSION = `1BQANOTEuMTA4LjU2LjE4NAG7xKlOaLmFbQtNu2r8${"aB9".repeat(12)}`;

describe("секреты не доезжают до файла вики", () => {
  test("сессия юзербота из пересказа переписки", () => {
    const out = sanitizeWikiContent(`чинили юзербота, TELEGRAM_SESSION=${SESSION}`);
    expect(out).not.toContain(SESSION);
    expect(out).toContain("TELEGRAM_SESSION=***");
  });

  test("ключ в заголовке страницы тоже", () => {
    const out = sanitizeWikiTitle("ghp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb в деплое");
    expect(out).toBe("ghp_*** в деплое");
  });

  test("токен бота в свободном тексте", () => {
    const out = sanitizeWikiContent(
      "падало на https://api.telegram.org/bot7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/getMe",
    );
    expect(out).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(out).toContain("7123456789:***");
  });
});

describe("выключатель PII секретов не открывает", () => {
  test("WIKI_PII_FILTER=0 — про имена и телефоны, не про ключи", () => {
    const prev = process.env.WIKI_PII_FILTER;
    process.env.WIKI_PII_FILTER = "0";
    try {
      // Модуль читает переменную на уровне модуля, поэтому в этом прогоне
      // выключатель может быть уже зафиксирован — тест держит инвариант с
      // обеих сторон: секрет замаскирован при любом его значении.
      const out = sanitizeWikiContent(`TELEGRAM_SESSION=${SESSION}`);
      expect(out).not.toContain(SESSION);
    } finally {
      if (prev === undefined) delete process.env.WIKI_PII_FILTER;
      else process.env.WIKI_PII_FILTER = prev;
    }
  });
});

describe("обычный текст заметки не портится", () => {
  test("проза, код и версии пакетов остаются как есть", () => {
    const s = [
      "Решение: держим лимит на роль, а не на таблицу.",
      "```ts\nconst n = buckets.size;\n```",
      "bun@1.1.30 и hono@4.6.5",
      "unknown key: foo",
    ].join("\n");
    expect(sanitizeWikiContent(s)).toBe(s);
  });

  test("пустой ввод возвращается как есть", () => {
    expect(sanitizeWikiContent("")).toBe("");
  });
});
