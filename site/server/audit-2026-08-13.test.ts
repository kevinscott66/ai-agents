/**
 * Серверный аудит 2026-08-13. Шесть находок, все воспроизведены до правки.
 *
 * 1. `xmlEscape` закрывал пять предопределённых сущностей и ничего не делал с
 *    управляющими символами. В XML 1.0 диапазон C0 запрещён НАСОВСЕМ — его
 *    нельзя даже записать числовой ссылкой, — а ингест текст не чистит:
 *    `handleIngestDigest` зовёт `.trim()`, который снимает только пробельные.
 *    Один U+0001 в заголовке одного дайджеста делает весь `/rss.xml` не
 *    well-formed: `xmllint` — «PCDATA invalid Char value 1», ElementTree —
 *    «not well-formed». Читалка теряет не строку, а всю ленту, и заметить это
 *    некому: тексты пишет модель, ошибка не выглядит как ошибка.
 *
 * 2. `/api/unlocks` отдавал максимум 100 строк, не знал offset и не возвращал
 *    total, тогда как `/api/stats` показывал 144 предстоящих разблокировки.
 *    44 события не открывались никаким запросом, а плитка «Пульса» вела на
 *    страницу, которая их и не могла показать.
 *
 * 3. Поиск по дайджестам матчил сырой `items_json`, то есть заодно ключи JSON
 *    и все ссылки на источники. На девяти дайджестах `http` находил 9 из 9,
 *    `com` — 8 из 9. Комментарий рядом утверждал, что такого не бывает.
 *
 * 4. Лимитер работал только внутри `routeApi`; `/rss.xml`, `/robots.txt` и
 *    `/sitemap.xml` шли мимо. Самый дорогой из них — sitemap: он читал все
 *    дайджесты и активности целиком и разбирал их JSON, пользуясь двумя
 *    полями.
 *
 * 5. Ингест принимал тело любого размера (проверено на 40 МБ).
 *
 * 6. Сравнение токена начиналось с `provided.length !== expected.length` —
 *    сам цикл честно константный, но только после того, как длина угадана.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-audit0813-"));
process.env.SITE_DB_PATH = join(TMP, "audit.db");

const { seedIfEmpty } = await import("./seed.ts");
const { listUpcomingUnlocks } = await import("./db.ts");
const { makeFetchHandler, _resetRateLimiter, clientIpKey } = await import(
  "./index.ts"
);

const TOKEN = "s3cret-ingest-token-0123456789ab";
const PREV_TOKEN = process.env.SITE_INGEST_TOKEN;

let server: ReturnType<typeof Bun.serve>;
let base: string;

const ingest = (body: unknown, token = TOKEN) =>
  fetch(`${base}/api/internal/digests`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeAll(async () => {
  process.env.SITE_DB_PATH = join(TMP, "audit.db");
  process.env.SITE_INGEST_TOKEN = TOKEN;
  seedIfEmpty();
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
  // Дайджест с управляющими символами в заголовке и аннотации — ровно то, что
  // мог бы прислать агент, склеивший текст из чужой выдачи.
  await ingest({
    id: "ctrl-chars-probe",
    title: "Заголовок\u0001 с\u0008 мусором\u000B",
    summary: "Аннотация\u001F с управляющими\u000C символами",
    items: [{ text: "пункт", url: "https://example.com/a" }],
  });
});

afterAll(() => {
  server.stop(true);
  // CLAUDE.md §3.8.7: env не течёт в соседние файлы тестов.
  if (PREV_TOKEN === undefined) delete process.env.SITE_INGEST_TOKEN;
  else process.env.SITE_INGEST_TOKEN = PREV_TOKEN;
});

beforeEach(() => _resetRateLimiter());

/** Символы, которых в XML 1.0 не может быть ни в каком виде. */
const XML_FORBIDDEN =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("XML остаётся разбираемым при мусоре из ингеста", () => {
  test("/rss.xml не содержит запрещённых символов", async () => {
    const xml = await (await fetch(`${base}/rss.xml`)).text();
    // Дайджест-зонд в ленте есть — иначе проверка ничего не значит.
    expect(xml).toContain("ctrl-chars-probe");
    expect(XML_FORBIDDEN.test(xml)).toBe(false);
  });

  test("текст сохраняется, вычищены только управляющие", async () => {
    const xml = await (await fetch(`${base}/rss.xml`)).text();
    expect(xml).toContain("<title>Заголовок с мусором</title>");
    expect(xml).toContain("Аннотация с управляющими символами");
  });

  test("/sitemap.xml тоже чист", async () => {
    const xml = await (await fetch(`${base}/sitemap.xml`)).text();
    expect(XML_FORBIDDEN.test(xml)).toBe(false);
  });

  test("пять предопределённых сущностей по-прежнему экранируются", async () => {
    await ingest({
      id: "entities-probe",
      title: 'A & B < C > D " E \' F',
      summary: "ссылка ?a=1&b=2",
      items: [],
    });
    const xml = await (await fetch(`${base}/rss.xml`)).text();
    expect(xml).toContain(
      "<title>A &amp; B &lt; C &gt; D &quot; E &apos; F</title>",
    );
  });
});

describe("/api/unlocks — постраничный доступ ко всему календарю", () => {
  test("отдаёт total, а не только items", async () => {
    const r = await (await fetch(`${base}/api/unlocks?limit=1`)).json();
    expect(typeof r.total).toBe("number");
    expect(r.items.length).toBeLessThanOrEqual(1);
    expect(r.total).toBeGreaterThanOrEqual(r.items.length);
  });

  test("offset двигает окно", async () => {
    const all = (await (await fetch(`${base}/api/unlocks?limit=4`)).json())
      .items;
    if (all.length < 4) return; // фикстур мало — проверять нечего
    const shifted = (
      await (await fetch(`${base}/api/unlocks?limit=2&offset=2`)).json()
    ).items;
    expect(shifted[0].symbol).toBe(all[2].symbol);
    expect(shifted[0].date).toBe(all[2].date);
  });

  test("порядок полный — соседние окна не пересекаются", () => {
    // ORDER BY был только по date; при нескольких событиях на одну дату
    // постраничная выборка вольна вернуть строку дважды и потерять соседнюю.
    const page1 = listUpcomingUnlocks(3, 0);
    const page2 = listUpcomingUnlocks(3, 3);
    const key = (u: { symbol: string; date: string; project: string }) =>
      `${u.date}|${u.symbol}|${u.project}`;
    const seen = new Set(page1.map(key));
    for (const u of page2) expect(seen.has(key(u))).toBe(false);
  });

  test("offset за концом даёт пустой список, а не ошибку", async () => {
    const r = await (
      await fetch(`${base}/api/unlocks?offset=99999999`)
    ).json();
    expect(r.items).toEqual([]);
    expect(typeof r.total).toBe("number");
  });
});

describe("поиск по дайджестам ищет по тексту, а не по блобу", () => {
  const search = async (q: string) =>
    (await (await fetch(`${base}/api/digests?q=${encodeURIComponent(q)}`)).json())
      .total as number;

  test("служебные ключи JSON больше не совпадают ни с чем", async () => {
    // До правки оба возвращали все дайджесты сразу.
    expect(await search("text")).toBe(0);
    expect(await search("url")).toBe(0);
  });

  test("схема и домены ссылок не превращают запрос в «показать всё»", async () => {
    const total = (await (await fetch(`${base}/api/digests?limit=1`)).json())
      .total as number;
    expect(total).toBeGreaterThan(1);
    // До правки: http → 9 из 9, com → 8 из 9.
    expect(await search("http")).toBeLessThan(total);
    expect(await search("com")).toBeLessThan(total);
  });

  test("текст внутри пунктов по-прежнему находится", async () => {
    await ingest({
      id: "search-probe",
      title: "Заголовок без ключевого слова",
      summary: "Аннотация без него же",
      items: [{ text: "уникальноеслово внутри пункта", url: "https://a.example" }],
    });
    const r = await (
      await fetch(`${base}/api/digests?q=${encodeURIComponent("уникальноеслово")}`)
    ).json();
    expect(r.total).toBe(1);
    expect(r.items[0].id).toBe("search-probe");
  });

  test("битый items_json не роняет запрос", async () => {
    // Изначально проверка стояла на json_each: он бросает на невалидной
    // строке и убивал весь SELECT, поэтому в условие поиска был вписан
    // json_valid. Аудит 2026-08-13 (второй заход) убрал json_each из поиска
    // совсем — сложенный регистр лежит в `search_text`, — так что уронить
    // выборку битый блоб больше не может по устройству. Остаётся вторая
    // половина того же инварианта: строка с битым JSON должна доезжать до
    // читателя, а не превращать ответ в 500 при разборе на чтении.
    //
    // Пишем мимо ингеста, сырым SQL: в проде единственный писатель —
    // upsertDigest (проверено grep'ом по site/), поэтому такая строка может
    // взяться только из ручной правки базы или из старого дампа.
    const { getDb } = await import("./db.ts");
    getDb()
      .query(
        "INSERT OR REPLACE INTO digests (id, title, date, summary, items_json, source_count, body)" +
          " VALUES (?, ?, ?, ?, ?, 0, '')",
      )
      .run(
        "broken-json-probe",
        "Битый блоб",
        "2099-01-01",
        "аннотация",
        "{не json",
      );
    const r = await fetch(`${base}/api/digests?limit=1`);
    expect(r.status).toBe(200);
    const body = await r.json();
    // Дата в будущем — строка идёт первой в ленте, отсортированной по date.
    expect(body.items[0].id).toBe("broken-json-probe");
    expect(body.items[0].items).toEqual([]);
  });
});

describe("лимитер накрывает не только /api/", () => {
  for (const path of ["/sitemap.xml", "/rss.xml", "/robots.txt"]) {
    test(`${path} упирается в лимит`, async () => {
      let ok = 0;
      let limited = 0;
      for (let i = 0; i < 70; i++) {
        const r = await fetch(base + path);
        await r.text();
        if (r.status === 429) limited++;
        else if (r.status === 200) ok++;
      }
      // До правки: 70 из 70 отвечали 200.
      expect(limited).toBeGreaterThan(0);
      // Второй проход того же дня: было `toBeLessThanOrEqual(60)`, и эта
      // формулировка пропускала ровно ту регрессию, которую внесла соседняя
      // починка, — 30 ≤ 60. Теперь нижняя граница: ведро на 60 токенов обязано
      // отдать 60 ответов, а не половину. Верхнюю не проверяем — за время
      // цикла ведро успевает капнуть (1 токен/с), и точное равенство было бы
      // гонкой с планировщиком.
      expect(ok).toBeGreaterThanOrEqual(60);
    });
  }

  test("один GET — один токен, а не два", async () => {
    // Прямая проверка на двойное списание: `/rss.xml` и `/sitemap.xml`
    // проверялись лимитером дважды за запрос — в общем блоке дорогих маршрутов
    // и ещё раз внутри ветки xmlRoute. При ёмкости 60 это давало первый 429 на
    // 31-м запросе. 40 подряд обязаны пройти целиком.
    for (const path of ["/rss.xml", "/sitemap.xml"]) {
      _resetRateLimiter();
      let ok = 0;
      for (let i = 0; i < 40; i++) {
        const r = await fetch(base + path);
        await r.text();
        if (r.status === 200) ok++;
      }
      expect(ok).toBe(40);
    }
  });

  test("ведро одно на все эти маршруты", async () => {
    // Ключ ведра — адрес, не путь. Смешанный трафик обязан считаться вместе,
    // иначе «60/мин» на деле означает 60 на каждый адрес.
    _resetRateLimiter();
    const paths = ["/rss.xml", "/sitemap.xml", "/robots.txt"];
    let limited = 0;
    for (let i = 0; i < 90; i++) {
      const r = await fetch(base + paths[i % paths.length]!);
      await r.text();
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  test("hardening-заголовки теперь есть и на этих маршрутах", async () => {
    const r = await fetch(`${base}/rss.xml`);
    await r.text();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
  });
});

describe("ингест: потолок на размер тела", () => {
  test("тело больше мегабайта отклоняется с 413", async () => {
    const big = {
      id: "too-big",
      title: "заголовок",
      summary: "аннотация",
      items: [{ text: "x".repeat(2 * 1024 * 1024), url: "https://a.example" }],
    };
    const r = await ingest(big);
    expect(r.status).toBe(413);
    expect(await r.json()).toEqual({ error: "payload_too_large" });
  });

  test("нормальный дайджест проходит", async () => {
    const r = await ingest({
      id: "normal-size",
      title: "обычный",
      summary: "обычная аннотация",
      items: [{ text: "пункт", url: "https://a.example" }],
    });
    expect(r.status).toBe(200);
  });
});

describe("сравнение токена не выдаёт длину", () => {
  test("неверный токен любой длины — 401", async () => {
    for (const t of ["", "x", "x".repeat(31), "x".repeat(32), "x".repeat(300)]) {
      const r = await ingest({ title: "t", summary: "s" }, t);
      expect(r.status).toBe(401);
    }
  });

  test("верный токен по-прежнему принимается", async () => {
    const r = await ingest({
      id: "token-ok",
      title: "t",
      summary: "s",
      items: [],
    });
    expect(r.status).toBe(200);
  });
});

describe("clientIpKey — источник адреса задаётся явно", () => {
  test("неизвестный peer больше не включает доверие к заголовку", () => {
    // Раньше `peer === null` попадал в ту же ветку, что и loopback.
    expect(clientIpKey("9.9.9.9", null)).toBe("ip:unknown");
  });

  test("без настройки — прежнее поведение: последний хоп X-Forwarded-For", () => {
    expect(clientIpKey("9.9.9.9, 10.0.0.7", "127.0.0.1")).toBe("ip:10.0.0.7");
  });

  test("заданный заголовок перебивает X-Forwarded-For", () => {
    expect(clientIpKey("9.9.9.9, 10.0.0.7", "127.0.0.1", "203.0.113.5")).toBe(
      "ip:203.0.113.5",
    );
  });

  test("прямое обращение снаружи — заголовки игнорируются", () => {
    expect(clientIpKey("9.9.9.9", "203.0.113.9", "8.8.8.8")).toBe(
      "ip:203.0.113.9",
    );
  });
});
