/**
 * Аудит 2026-08-12: пост в ЛЮБОЙ командный канал становился публичной
 * страницей на delabs.space.
 *
 * `ingestDigestToSite(postText)` принимала только текст — канала в сигнатуре не
 * было вообще, значит и отфильтровать по нему было нечего. А публиковать
 * PUBLISH_TO_CHANNEL разрешает в любой канал из реестра `team_channels`
 * (`isTeamChannel(p.channelId, ctx.chatId)`), то есть в любой рабочий канал,
 * который команда завела через CREATE_TEAM_CHANNEL, — не только в публичный
 * @delabsru.
 *
 * Аудит 2026-08-11 сузил мост до «постов со ссылками» (нет источников — нет
 * дайджеста), но условия «это наш публичный канал» так и не появилось. Итог:
 * роль постит во внутренний канал сводку со ссылками на источники/PR → парсер
 * видит ≥1 markdown-ссылку → POST /api/internal/digests → карточка на
 * delabs.space, страница /digest/<slug> и запись в /rss.xml, открытые всем без
 * авторизации.
 *
 * Человек в контуре был — PUBLISH_TO_CHANNEL сидит в ALWAYS_APPROVE_ACTIONS, —
 * но апрувил он пост в конкретный Telegram-канал, а не публикацию на сайт.
 * Снять страницу обратно нельзя: RSS уже разошёлся.
 *
 * Инвариант: на сайт уходит только то, что опубликовано в публичный канал
 * (SITE_INGEST_CHANNEL_ID / DELABS_CHANNEL_ID). Пост в любой другой канал —
 * no-op, даже если он идеально разбирается как дайджест.
 */
import { describe, test, expect, beforeEach, afterAll, spyOn } from "bun:test";
import {
  ingestDigestToSite,
  _resetIngestDedup,
  siteIngestChannelId,
  DEFAULT_SITE_CHANNEL_ID,
} from "../lib/site-ingest.ts";

const mockFetch = spyOn(globalThis, "fetch");

const PREV = {
  url: process.env.SITE_INGEST_URL,
  token: process.env.SITE_INGEST_TOKEN,
  chan: process.env.SITE_INGEST_CHANNEL_ID,
  delabs: process.env.DELABS_CHANNEL_ID,
  allow: process.env.SITE_INGEST_ALLOW_IN_TESTS,
};

const DIGEST = [
  "**Итоги недели**",
  "",
  "Разобрали активности недели.",
  "",
  "🔹 [Monad тестнет](https://testnet.monad.xyz) — фаза 2",
].join("\n");

const PUBLIC_CHANNEL = -1004471352065;
const INTERNAL_CHANNEL = -1002222333444;

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  _resetIngestDedup();
  process.env.SITE_INGEST_URL = "https://site.example/api/internal/digests";
  process.env.SITE_INGEST_TOKEN = "secret-token";
  delete process.env.SITE_INGEST_CHANNEL_ID;
  delete process.env.DELABS_CHANNEL_ID;
  // T-743: под `bun test` мост закрыт по умолчанию; здесь проверяется он сам
  // и fetch подменён — включаем явно.
  process.env.SITE_INGEST_ALLOW_IN_TESTS = "1";
});

afterAll(() => {
  mockFetch.mockRestore();
  for (const [k, v] of [
    ["SITE_INGEST_URL", PREV.url],
    ["SITE_INGEST_TOKEN", PREV.token],
    ["SITE_INGEST_CHANNEL_ID", PREV.chan],
    ["DELABS_CHANNEL_ID", PREV.delabs],
    ["SITE_INGEST_ALLOW_IN_TESTS", PREV.allow],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("на сайт уходит только публичный канал", () => {
  test("дайджест из внутреннего канала на сайт НЕ едет", async () => {
    await ingestDigestToSite(DIGEST, INTERNAL_CHANNEL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("тот же самый текст из публичного канала — едет", async () => {
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("SITE_INGEST_CHANNEL_ID переопределяет канал", async () => {
    process.env.SITE_INGEST_CHANNEL_ID = String(INTERNAL_CHANNEL);
    await ingestDigestToSite(DIGEST, INTERNAL_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    mockFetch.mockReset();
    mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    _resetIngestDedup();
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("DELABS_CHANNEL_ID работает как запасной источник", async () => {
    process.env.DELABS_CHANNEL_ID = String(INTERNAL_CHANNEL);
    await ingestDigestToSite(DIGEST, INTERNAL_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("канал без id (undefined) — не публикуем", async () => {
    await ingestDigestToSite(DIGEST, undefined as unknown as number);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("резолв разрешённого канала фейлится в сторону известного публичного", () => {
  test("ничего не задано — дефолт", () => {
    expect(siteIngestChannelId()).toBe(DEFAULT_SITE_CHANNEL_ID);
  });

  test("мусор в переменной не открывает мост всем подряд", () => {
    for (const junk of ["", "   ", "abc", "-100abc", "NaN"]) {
      process.env.SITE_INGEST_CHANNEL_ID = junk;
      expect(siteIngestChannelId()).toBe(DEFAULT_SITE_CHANNEL_ID);
    }
    delete process.env.SITE_INGEST_CHANNEL_ID;
  });

  test("SITE_INGEST_CHANNEL_ID приоритетнее DELABS_CHANNEL_ID", () => {
    process.env.SITE_INGEST_CHANNEL_ID = "-100111";
    process.env.DELABS_CHANNEL_ID = "-100222";
    expect(siteIngestChannelId()).toBe(-100111);
  });
});
