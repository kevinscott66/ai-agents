/**
 * Аудит 2026-08-12, второй заход: то, что читающий проход нашёл в сервере.
 *
 * Четыре инварианта, каждый — с ценой в проде:
 *
 * 1. Лимит покрывает не только `/api/*`. `rateLimitOk` звался внутри
 *    `routeApi`, поэтому `/rss.xml`, `/sitemap.xml` и `/digest/<id>` шли мимо
 *    него вовсе. `/sitemap.xml` при этом читал обе таблицы целиком (`SELECT *`
 *    с колонкой `body` и `JSON.parse` на каждую строку) ради `id` и `date` —
 *    то есть `while true; do curl …/sitemap.xml; done` синхронно занимал
 *    event loop бесплатно.
 * 2. Ленты кэшируются, но не врут. Кэш держит готовый XML десять минут и при
 *    этом сбрасывается по счётчику правок — свежая статья попадает в ленту
 *    сразу, а не через десять минут.
 * 3. Ингест имеет потолки. Токен даёт право писать, но не право положить в
 *    SQLite мегабайт: длина полей, число элементов и форма `id` ограничены.
 * 4. Служебные адреса получают hardening-заголовки. `/rss.xml`,
 *    `/sitemap.xml` и `/robots.txt` возвращались напрямую, без
 *    `withSecurityHeaders`: свой nosniff они ставили, а X-Frame-Options и
 *    Referrer-Policy — нет, то есть их можно было фреймить.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-audit0812-"));
process.env.SITE_DB_PATH = join(TMP, "audit.db");

const { seedIfEmpty } = await import("./seed.ts");
const { upsertUnlocks } = await import("./db.ts");
const { makeFetchHandler, _resetRateLimiter, invalidateFeedCache, clientIpKey } =
  await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

const TOKEN = "audit-0812-token";

beforeAll(() => {
  process.env.SITE_DB_PATH = join(TMP, "audit.db");
  seedIfEmpty();
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

beforeEach(() => {
  _resetRateLimiter();
  invalidateFeedCache();
});

/** POST в ингест дайджестов с валидным токеном. */
async function ingest(body: unknown): Promise<Response> {
  const prev = process.env.SITE_INGEST_TOKEN;
  process.env.SITE_INGEST_TOKEN = TOKEN;
  try {
    return await fetch(`${base}/api/internal/digests`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify(body),
    });
  } finally {
    if (prev === undefined) delete process.env.SITE_INGEST_TOKEN;
    else process.env.SITE_INGEST_TOKEN = prev;
  }
}

describe("лимит покрывает дорогие не-API маршруты", () => {
  // Ведро — 60 токенов на ключ. Ключ здесь один: запросы идут с localhost без
  // XFF, то есть все 70 попаданий в одно ведро.
  test("/sitemap.xml упирается в 429", async () => {
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      const r = await fetch(`${base}/sitemap.xml`);
      if (r.status === 429) limited++;
      await r.arrayBuffer();
    }
    expect(limited).toBeGreaterThan(0);
  });

  test("429 приходит с Retry-After и hardening-заголовками", async () => {
    let res: Response | null = null;
    for (let i = 0; i < 70; i++) {
      const r = await fetch(`${base}/rss.xml`);
      await r.arrayBuffer();
      if (r.status === 429) { res = r; break; }
    }
    expect(res).not.toBeNull();
    expect(res!.headers.get("retry-after")).toBe("60");
    expect(res!.headers.get("x-frame-options")).toBe("DENY");
  });

  test("статика под лимит не попадает — страница тянет несколько файлов", async () => {
    // 70 запросов к статике подряд: ни одного 429. Иначе обычная навигация по
    // сайту (index.html + css + js + иконка на каждую страницу) упиралась бы
    // в общий бюджет 60/мин.
    //
    // Раньше здесь стоял `/robots.txt` — как заглушка «что-нибудь статическое».
    // Заглушка оказалась неверной: robots.txt тут не файл, а генерируемый
    // маршрут, и браузер при навигации его не запрашивает вовсе — только
    // краулер, раз за обход. Под лимит он с 2026-08-13 попадает намеренно.
    // Проверяем то, что тест и имел в виду: путь ассета.
    let limited = 0;
    for (let i = 0; i < 70; i++) {
      const r = await fetch(`${base}/assets/index-deadbeef.js`);
      if (r.status === 429) limited++;
      await r.arrayBuffer();
    }
    expect(limited).toBe(0);
  });
});

describe("кэш лент", () => {
  test("повторный запрос отдаёт то же тело", async () => {
    const a = await (await fetch(`${base}/sitemap.xml`)).text();
    const b = await (await fetch(`${base}/sitemap.xml`)).text();
    expect(b).toBe(a);
  });

  test("новая статья появляется в ленте сразу, а не через TTL", async () => {
    const before = await (await fetch(`${base}/sitemap.xml`)).text();
    expect(before).not.toContain("cache-bust-0812");

    const r = await ingest({
      id: "cache-bust-0812",
      title: "Проверка сброса кэша",
      summary: "Статья должна появиться в карте сайта немедленно.",
      date: new Date().toISOString(),
    });
    expect(r.status).toBe(200);

    // Кэш НЕ сбрасываем руками — его должен обнулить счётчик правок.
    const after = await (await fetch(`${base}/sitemap.xml`)).text();
    expect(after).toContain("cache-bust-0812");
  });
});

describe("потолки ингеста", () => {
  test("длинные поля обрезаются, а не уезжают в базу целиком", async () => {
    // Тело держим под транспортным потолком в 1 МиБ (аудит 2026-08-13): у
    // кириллицы в UTF-8 два байта на символ, и прежние 500 000 символов тела
    // давали 1.1 МБ — то есть запрос отлетал с 413 и до обрезки полей дело не
    // доходило вовсе. 300 000 символов — это 600 КБ, всё ещё втрое больше
    // потолка поля (200 000), но в пределах транспортного.
    const r = await ingest({
      id: "clip-0812",
      title: "Т".repeat(5_000),
      summary: "С".repeat(50_000),
      body: "Б".repeat(300_000),
      date: new Date().toISOString(),
    });
    expect(r.status).toBe(200);

    const d = await (await fetch(`${base}/api/digests/clip-0812`)).json();
    expect(d.title.length).toBe(300);
    expect(d.summary.length).toBe(2_000);
    expect(d.body.length).toBe(200_000);
  });

  test("число пунктов ограничено сотней", async () => {
    const r = await ingest({
      id: "many-items-0812",
      title: "Много пунктов",
      summary: "Проверка потолка на число элементов.",
      date: new Date().toISOString(),
      items: Array.from({ length: 500 }, (_, i) => ({ text: `пункт ${i}` })),
    });
    expect(r.status).toBe(200);
    const d = await (await fetch(`${base}/api/digests/many-items-0812`)).json();
    expect(d.items.length).toBe(100);
  });

  test("кривой id — 400, а не тихая запись", async () => {
    for (const bad of ["сегмент/с-слэшем", "с пробелом", "-начинается-с-дефиса", "x".repeat(200)]) {
      const r = await ingest({
        id: bad,
        title: "Кривой id",
        summary: "Не должно записаться.",
        date: new Date().toISOString(),
      });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("invalid_id");
    }
  });

  test("нормальный кириллический id по-прежнему принимается", async () => {
    const r = await ingest({
      id: "2026-08-12-крючок",
      title: "Обычный слаг",
      summary: "Такие id пишет наш же мост.",
      date: new Date().toISOString(),
    });
    expect(r.status).toBe(200);
  });
});

describe("hardening-заголовки на служебных адресах", () => {
  for (const path of ["/rss.xml", "/sitemap.xml", "/robots.txt"]) {
    test(`${path} нельзя фреймить`, async () => {
      const r = await fetch(`${base}${path}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      // Свой nosniff у них был и раньше — он не должен потеряться.
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    });
  }

  test("CSP запрещает отправку форм — на сайте нет ни одной", async () => {
    const r = await fetch(`${base}/api/stats`);
    expect(r.headers.get("content-security-policy")).toContain("form-action 'none'");
  });

  test("HSTS отдаётся без includeSubDomains", async () => {
    const r = await fetch(`${base}/api/stats`);
    const hsts = r.headers.get("strict-transport-security");
    expect(hsts).toContain("max-age=");
    // Под dobropalm.tech живут посторонние поддомены — запирать их не наше дело.
    expect(hsts).not.toContain("includeSubDomains");
  });
});

describe("календарь разблокировок листается целиком", () => {
  const DAY = 24 * 60 * 60 * 1000;

  // 250 будущих разблокировок: больше прежнего жёсткого потолка в 100, чтобы
  // «за сотней» было что искать. Первые 12 — внутри недели.
  function seedUnlocks() {
    const rows = Array.from({ length: 250 }, (_, i) => ({
      project: `Проект ${String(i).padStart(3, "0")}`,
      symbol: `T${i}`,
      // Первые 12 — по два в день на ближайшие 6 дней; дальше — по дню на штуку.
      date: new Date(Date.now() + (i < 12 ? Math.floor(i / 2) + 1 : i) * DAY).toISOString(),
      pctOfSupply: 1,
      amountUsd: 1000 + i,
    }));
    upsertUnlocks(rows);
  }

  test("total считает всё, а не размер страницы", async () => {
    seedUnlocks();
    const d = await (await fetch(`${base}/api/unlocks?limit=30`)).json();
    expect(d.items.length).toBe(30);
    expect(d.total).toBeGreaterThanOrEqual(250);
  });

  test("offset достаёт то, что раньше было недостижимо", async () => {
    const page = await (await fetch(`${base}/api/unlocks?limit=20&offset=200`)).json();
    expect(page.items.length).toBe(20);
    const first = await (await fetch(`${base}/api/unlocks?limit=20&offset=0`)).json();
    const overlap = page.items.filter((u: { project: string }) =>
      first.items.some((f: { project: string }) => f.project === u.project),
    );
    expect(overlap).toEqual([]);
  });

  test("страницы не пересекаются и не теряют строк", async () => {
    const seen: string[] = [];
    for (let off = 0; off < 90; off += 30) {
      const p = await (await fetch(`${base}/api/unlocks?limit=30&offset=${off}`)).json();
      for (const u of p.items) seen.push(`${u.project}|${u.date}`);
    }
    expect(seen.length).toBe(90);
    expect(new Set(seen).size).toBe(90);
  });

  test("окно «7 дней» считает сервер — total сужается вместе с выдачей", async () => {
    const all = await (await fetch(`${base}/api/unlocks?limit=1`)).json();
    const week = await (await fetch(`${base}/api/unlocks?limit=100&within=7`)).json();
    expect(week.total).toBeLessThan(all.total);
    expect(week.items.length).toBe(week.total);
    const cutoff = Date.now() + 7 * DAY;
    expect(week.items.every((u: { date: string }) => Date.parse(u.date) <= cutoff)).toBe(true);
  });

  test("order=desc переворачивает выборку, а не показанную страницу", async () => {
    const asc = await (await fetch(`${base}/api/unlocks?limit=5`)).json();
    const desc = await (await fetch(`${base}/api/unlocks?limit=5&order=desc`)).json();
    expect(Date.parse(desc.items[0].date)).toBeGreaterThan(Date.parse(asc.items[0].date));
    // Обе стороны видят один и тот же набор — значит total не зависит от порядка.
    expect(desc.total).toBe(asc.total);
  });
});

describe("поисковый запрос ограничен по длине", () => {
  test("q обрезается на 120 символах", async () => {
    // Заголовок из 150 «ж». Запрос — 120 «ж» плюс хвост, которого в заголовке
    // нет. Если обрезка работает, до `LIKE` доедут только первые 120 и статья
    // найдётся; если нет — выдача будет пустой.
    await ingest({
      id: "long-q-0812",
      title: "ж".repeat(150),
      summary: "Проверка потолка длины поискового запроса.",
      date: new Date().toISOString(),
    });
    const q = "ж".repeat(120) + "ХВОСТ-КОТОРОГО-НЕТ";
    const d = await (await fetch(`${base}/api/digests?q=${encodeURIComponent(q)}`)).json();
    expect(d.items.some((x: { id: string }) => x.id === "long-q-0812")).toBe(true);
  });

  test("обычный поиск по-прежнему находит", async () => {
    await ingest({
      id: "search-0812",
      title: "Уникальное слово квазар",
      summary: "Чтобы поиск было чем проверять.",
      date: new Date().toISOString(),
    });
    const d = await (await fetch(`${base}/api/digests?q=квазар`)).json();
    expect(d.items.some((x: { id: string }) => x.id === "search-0812")).toBe(true);
  });
});

describe("CORS отвечает только своим", () => {
  async function acao(origin: string): Promise<string | null> {
    const r = await fetch(`${base}/api/stats`, { headers: { Origin: origin } });
    await r.arrayBuffer();
    return r.headers.get("access-control-allow-origin");
  }

  test("свой домен и его поддомены проходят", async () => {
    expect(await acao("https://delabs.space")).toBe("https://delabs.space");
    expect(await acao("https://www.delabs.space")).toBe("https://www.delabs.space");
    expect(await acao("https://agents.example.com")).toBe("https://agents.example.com");
  });

  test("похожий чужой домен не проходит", async () => {
    expect(await acao("https://evil-delabs.space")).toBeNull();
    expect(await acao("https://delabs.space.evil.com")).toBeNull();
  });

  test("localhost — только на наших портах разработки", async () => {
    expect(await acao("http://localhost:5173")).toBe("http://localhost:5173");
    expect(await acao("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790");
    // Чужой локальный сервер разработчика — не наше дело.
    expect(await acao("http://localhost:3000")).toBeNull();
  });

  test("не-веб-схема с нашим хостом не проходит", async () => {
    expect(await acao("ftp://delabs.space")).toBeNull();
    expect(await acao("chrome-extension://delabs.space")).toBeNull();
  });

  test("мусор в Origin не роняет обработчик", async () => {
    const r = await fetch(`${base}/api/stats`, { headers: { Origin: "not-a-url" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBeNull();
    expect(r.headers.get("vary")).toBe("Origin");
  });
});

// Третий аргумент — значение заголовка, заданного через SITE_CLIENT_IP_HEADER
// (аудит 2026-08-13); число хопов уехало на четвёртую позицию. Здесь заголовок
// не задан, поэтому везде null.
describe("число доверенных прокси-хопов настраивается", () => {
  test("по умолчанию верим одному — берём последний элемент", () => {
    expect(clientIpKey("1.2.3.4, 203.0.113.9", "127.0.0.1")).toBe("ip:203.0.113.9");
  });

  test("за двумя своими прокси берём предпоследний", () => {
    expect(clientIpKey("1.2.3.4, 203.0.113.9, 10.0.0.2", "127.0.0.1", null, 2)).toBe(
      "ip:203.0.113.9",
    );
  });

  test("хопов больше, чем элементов, — берём самый левый, а не undefined", () => {
    expect(clientIpKey("203.0.113.9", "127.0.0.1", null, 5)).toBe("ip:203.0.113.9");
  });
});
