/**
 * Аудит 2026-08-11: мост «пост в канале → карточка на сайте» стоял на КАЖДОЙ
 * публикации.
 *
 * `void ingestDigestToSite(fullText)` висит на всех четырёх выходах PUBLISH_POST
 * (юзербот, фото+подпись, фото+текст, просто текст) — то есть карточка на сайте
 * появляется от любого поста в канале: анонса в одну строку, мема, «тест 1».
 * Дайджестом там даже не пахнет: ссылок нет, items = [], sourceCount = 0, а
 * summary откатывается на title фолбэком — карточка «заголовок = описание, 0
 * источников». Ровно тот однотипный вид, на который жалуется владелец, и ровно
 * тот механизм, которым на сайт попали тестовые публикации (T-743).
 *
 * Второе: идемпотентности нет. Один и тот же пост, опубликованный дважды
 * (повтор после потерянного ответа Telegram — сценарий, ради которого мы
 * НЕ ретраим автоматически), давал на сайте две одинаковые карточки.
 *
 * Инвариант: на сайт уходит только то, что реально дайджест (есть источники),
 * и один и тот же текст уходит один раз.
 */
import { describe, test, expect, beforeEach, afterAll, spyOn } from "bun:test";
import { ingestDigestToSite, _resetIngestDedup } from "../lib/site-ingest.ts";

const mockFetch = spyOn(globalThis, "fetch");

const PREV_URL = process.env.SITE_INGEST_URL;
const PREV_TOKEN = process.env.SITE_INGEST_TOKEN;
const PREV_ALLOW = process.env.SITE_INGEST_ALLOW_IN_TESTS;

const PUBLIC_CHANNEL = -1004471352065;

const DIGEST = [
  "**Итоги недели**",
  "",
  "Разобрали активности недели.",
  "",
  "🔹 [Monad тестнет](https://testnet.monad.xyz) — фаза 2",
  "",
  "💬 [ЧАТ](https://t.me/x) сообщества **© Copyright 2023-2026 DeLabs**🤑",
].join("\n");

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockResolvedValue(new Response("{}", { status: 200 }));
  _resetIngestDedup();
  process.env.SITE_INGEST_URL = "https://site.example/api/internal/digests";
  process.env.SITE_INGEST_TOKEN = "secret-token";
  // T-743: под `bun test` мост закрыт по умолчанию; здесь проверяется он сам
  // и fetch подменён — включаем явно.
  process.env.SITE_INGEST_ALLOW_IN_TESTS = "1";
});

afterAll(() => {
  mockFetch.mockRestore();
  if (PREV_URL === undefined) delete process.env.SITE_INGEST_URL;
  else process.env.SITE_INGEST_URL = PREV_URL;
  if (PREV_TOKEN === undefined) delete process.env.SITE_INGEST_TOKEN;
  else process.env.SITE_INGEST_TOKEN = PREV_TOKEN;
  if (PREV_ALLOW === undefined) delete process.env.SITE_INGEST_ALLOW_IN_TESTS;
  else process.env.SITE_INGEST_ALLOW_IN_TESTS = PREV_ALLOW;
});

describe("ingestDigestToSite: на сайт едет только дайджест", () => {
  test("пост без единого источника карточку не создаёт", async () => {
    await ingestDigestToSite("тест 1", PUBLIC_CHANNEL);
    await ingestDigestToSite("Всем привет! Завтра эфир в 19:00, приходите.", PUBLIC_CHANNEL);
    await ingestDigestToSite("📰 **Анонс**\n\nЗавтра расскажем про Monad.", PUBLIC_CHANNEL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("настоящий дайджест уходит", async () => {
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.sourceCount).toBe(1);
  });

  test("ссылки только в футере — это не источники", async () => {
    // Футер сам по себе содержит ссылки; карточка из одного футера бессмысленна.
    await ingestDigestToSite(
      "Хороших выходных!\n\n💬 [ЧАТ](https://t.me/x) сообщества **© Copyright 2023-2026 DeLabs**🤑",
      PUBLIC_CHANNEL,
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("ingestDigestToSite: один пост — одна карточка", () => {
  test("повторная публикация того же текста не дублирует карточку", async () => {
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("другой дайджест проходит", async () => {
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    await ingestDigestToSite(DIGEST.replace("Monad тестнет", "Scroll Sessions"), PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("неудачная отправка не считается доставленной", async () => {
    // Иначе первый же сетевой сбой навсегда закрывает дорогу этому дайджесту.
    mockFetch.mockRejectedValueOnce(new Error("network down"));
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    await ingestDigestToSite(DIGEST, PUBLIC_CHANNEL);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
