// Tests for the digest -> site ingest bridge (T-804).
import {
  describe,
  test,
  expect,
  beforeEach,
  afterAll,
  spyOn,
} from "bun:test";
import {
  ingestDigestToSite,
  parseDigestPost,
  _resetIngestDedup,
} from "../lib/site-ingest.ts";

const mockFetch = spyOn(globalThis, "fetch");

const PUBLIC_CHANNEL = -1004471352065;

const SAMPLE_POST = [
  "**Дайджест Web3 за 14 июня**",
  "",
  "Сегодня в мире крипты много событий. Краткое интро поста перед пунктами.",
  "",
  "🔹 [Ethereum обновление](https://example.com/eth)",
  "🔹 [Solana запуск](https://example.com/sol)",
  "",
  "💬 [ЧАТ](https://t.me/x) сообщества © Copyright 2023-2026 DeLabs🤑",
].join("\n");

function setEnv(url: string | undefined, token: string | undefined) {
  if (url === undefined) delete process.env.SITE_INGEST_URL;
  else process.env.SITE_INGEST_URL = url;
  if (token === undefined) delete process.env.SITE_INGEST_TOKEN;
  else process.env.SITE_INGEST_TOKEN = token;
}

const PREV_URL = process.env.SITE_INGEST_URL;
const PREV_TOKEN = process.env.SITE_INGEST_TOKEN;

const PREV_ALLOW = process.env.SITE_INGEST_ALLOW_IN_TESTS;

beforeEach(() => {
  mockFetch.mockReset();
  // Дедуп процессный: без сброса второй тест с тем же постом молча уходил бы
  // в «уже отправляли» и не проверял ничего.
  _resetIngestDedup();
  // Под `bun test` мост закрыт по умолчанию (T-743: тесты публиковали страницы
  // на живом delabs.space). Здесь мы проверяем сам мост и fetch подменён —
  // включаем явно. См. tests/site-ingest-test-run-guard.test.ts.
  process.env.SITE_INGEST_ALLOW_IN_TESTS = "1";
});

afterAll(() => {
  mockFetch.mockRestore();
  setEnv(PREV_URL, PREV_TOKEN);
  if (PREV_ALLOW === undefined) delete process.env.SITE_INGEST_ALLOW_IN_TESTS;
  else process.env.SITE_INGEST_ALLOW_IN_TESTS = PREV_ALLOW;
});

describe("parseDigestPost", () => {
  test("extracts title, items and sourceCount; ignores footer", () => {
    const d = parseDigestPost(SAMPLE_POST);
    expect(d.title).toBe("Дайджест Web3 за 14 июня");
    expect(d.items.length).toBe(2);
    expect(d.sourceCount).toBe(2);
    expect(d.items[0]).toEqual({
      text: "Ethereum обновление",
      url: "https://example.com/eth",
    });
    // Footer link must NOT be an item.
    expect(d.items.some((it) => it.url?.includes("t.me/x"))).toBe(false);
    // Footer text must not leak into summary.
    expect(d.summary.toLowerCase()).not.toContain("copyright");
    expect(d.summary).toContain("интро");
    expect(d.summary.length).toBeLessThanOrEqual(300);
  });

  test("DeLabs-шаблон: приветствие/📰-шапка/🗓️-дата не попадают в summary", () => {
    const post = [
      "Отличного дня, 🤑",
      "",
      "📰 **Web3 Дайджест: свежие новости**",
      "🗓️ По состоянию на 14 июня",
      "",
      "Краткий обзор горячих событий Web3 и AI за сутки.",
      "",
      "🔥 **NEAR** вырос на 30% — [источник](https://example.com/near)",
      "",
      "💬 ЧАТ сообщества | Активности © Copyright 2023-2026 DeLabs🤑",
    ].join("\n");
    const d = parseDigestPost(post);
    expect(d.title).toBe("Web3 Дайджест: свежие новости");
    expect(d.summary).toContain("Краткий обзор");
    expect(d.summary.toLowerCase()).not.toContain("отличного дня");
    expect(d.summary).not.toContain("📰");
    expect(d.summary).not.toContain("🗓");
    expect(d.summary.toLowerCase()).not.toContain("copyright");
    expect(d.sourceCount).toBe(1);
  });

  test("falls back to first meaningful line when no bold title", () => {
    const d = parseDigestPost(
      "Просто первая значимая строка дайджеста\n\n[ссылка](https://example.com)",
    );
    expect(d.title).toBe("Просто первая значимая строка дайджеста");
    expect(d.items.length).toBe(1);
  });
});

describe("ingestDigestToSite", () => {
  test("does nothing when env is not configured", async () => {
    setEnv(undefined, undefined);
    await ingestDigestToSite(SAMPLE_POST, PUBLIC_CHANNEL);
    expect(mockFetch).not.toHaveBeenCalled();

    // Only one of the two also counts as disabled.
    setEnv("https://site.example/api/internal/digests", undefined);
    await ingestDigestToSite(SAMPLE_POST, PUBLIC_CHANNEL);
    expect(mockFetch).not.toHaveBeenCalled();

    setEnv(undefined, "secret");
    await ingestDigestToSite(SAMPLE_POST, PUBLIC_CHANNEL);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("POSTs correct body with Authorization when configured", async () => {
    setEnv("https://site.example/api/internal/digests", "secret-token");
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, id: "x" }), { status: 200 }),
    );

    await ingestDigestToSite(SAMPLE_POST, PUBLIC_CHANNEL);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://site.example/api/internal/digests");
    expect(options.method).toBe("POST");
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");
    const body = JSON.parse(options.body as string);
    expect(body.title).toBe("Дайджест Web3 за 14 июня");
    expect(body.sourceCount).toBe(2);
    expect(body.items.length).toBe(2);
    expect(body.items[0].url).toBe("https://example.com/eth");
  });

  test("never throws when fetch rejects", async () => {
    setEnv("https://site.example/api/internal/digests", "secret-token");
    mockFetch.mockRejectedValueOnce(new Error("network down"));
    // Must resolve without throwing.
    await expect(ingestDigestToSite(SAMPLE_POST, PUBLIC_CHANNEL)).resolves.toBeUndefined();
  });

  test("never throws on non-ok response", async () => {
    setEnv("https://site.example/api/internal/digests", "secret-token");
    mockFetch.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    await expect(ingestDigestToSite(SAMPLE_POST, PUBLIC_CHANNEL)).resolves.toBeUndefined();
  });
});
