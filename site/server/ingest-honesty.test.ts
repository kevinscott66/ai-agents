/**
 * Аудит 2026-08-13: ингест отвечал `{ok:true,id}` при любом исходе.
 *
 * Две отдельные немоты в одном ответе.
 *
 * 1. Потери. Цикл пунктов дайджеста выбрасывает всё, что не влезло в
 *    INGEST_MAX.items (100), и всё, у чего пустой или нестроковый `text`;
 *    `toStringArray` так же режет шаги активности по 50. Отправитель видел
 *    «ok» и считал, что опубликовал десять пунктов, хотя доехало шесть.
 *    Ошибкой это не назвать — материал в БД и на сайте, — поэтому лечим не
 *    статус, а немоту: в ответе едут «сколько сохранено» и «сколько
 *    потеряно», счётчиком, а не вычитанием.
 *
 * 2. Дата. `Date.parse` без границ, а на неудачу — молчаливая подмена на
 *    «сейчас». Год 9999 для Date.parse валиден, и дайджест с такой датой
 *    встаёт первым в ленте НАВСЕГДА (сортировка по date DESC): уронить
 *    главную опечаткой в одном поле было можно. А «12.08.2026» и «вчера»
 *    молча превращались в текущее время, и материал уезжал не в тот день.
 *
 * Инвариант: 200 означает «сохранено ровно то, что прислали», иначе в ответе
 * стоит счётчик потерь; присланная, но негодная дата — 400, а не подмена.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-honesty-"));
process.env.SITE_DB_PATH = join(TMP, "honesty.db");
process.env.SITE_INGEST_TOKEN = "honesty-test-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");
const db = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

async function post(kind: "digests" | "activities", body: unknown) {
  const r = await fetch(`${base}/api/internal/${kind}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer honesty-test-token",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const DAY = "2026-08-12T09:00:00.000Z";

describe("ингест называет потери", () => {
  test("пунктов больше потолка — счётчик в ответе", async () => {
    // 120 при потолке 100: двадцать пунктов не сохраняются.
    const items = Array.from({ length: 120 }, (_, i) => ({ text: `пункт ${i}` }));
    const r = await post("digests", {
      title: "Дайджест со ста двадцатью пунктами",
      summary: "Сводка.",
      date: DAY,
      items,
    });

    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    // До правки здесь было только {ok,id}.
    expect(r.json.items).toBe(100);
    expect(r.json.droppedItems).toBe(20);
    expect(db.getDigest(String(r.json.id))?.items).toHaveLength(100);
  });

  test("негодные пункты считаются потерянными, а не пропадают", async () => {
    const r = await post("digests", {
      title: "Дайджест с мусором в пунктах",
      summary: "Сводка.",
      date: DAY,
      items: [
        { text: "нормальный пункт" },
        { text: "" }, // пустой текст
        { text: 42 }, // не строка
        null, // вообще не объект
        { url: "https://example.com" }, // без текста
      ],
    });

    expect(r.status).toBe(200);
    expect(r.json.items).toBe(1);
    expect(r.json.droppedItems).toBe(4);
  });

  test("всё сохранено — счётчика потерь нет вовсе", async () => {
    // «0 потеряно» отдельным полем не пишем: пустое поле в каждом ответе
    // читается хуже, чем его отсутствие.
    const r = await post("digests", {
      title: "Обычный дайджест",
      summary: "Сводка.",
      date: DAY,
      items: [{ text: "раз" }, { text: "два" }],
    });
    expect(r.json.items).toBe(2);
    expect(r.json).not.toHaveProperty("droppedItems");
  });

  test("sourceCount виден в ответе — его тоже зажимают молча", async () => {
    const r = await post("digests", {
      title: "Дайджест с завышенным sourceCount",
      summary: "Сводка.",
      date: DAY,
      items: [{ text: "раз" }],
      sourceCount: 999_999,
    });
    // Потолок 10 000; отправитель теперь может сверить с тем, что послал.
    expect(r.json.sourceCount).toBe(10_000);
  });

  test("шаги активности сверх потолка — тот же счётчик", async () => {
    const steps = Array.from({ length: 60 }, (_, i) => `шаг ${i}`);
    const r = await post("activities", {
      project: "TestNet",
      title: "Гайд из шестидесяти шагов",
      steps,
    });
    expect(r.status).toBe(200);
    expect(r.json.steps).toBe(50);
    expect(r.json.droppedSteps).toBe(10);
  });

  test("активность без потерь — поля нет", async () => {
    const r = await post("activities", {
      project: "TestNet",
      title: "Короткий гайд",
      steps: ["раз", "два"],
    });
    expect(r.json.steps).toBe(2);
    expect(r.json).not.toHaveProperty("droppedSteps");
  });
});

describe("дата: границы вместо молчаливой подмены", () => {
  test("год 9999 отклоняется, а не встаёт первым в ленте навсегда", async () => {
    const r = await post("digests", {
      title: "Дайджест из будущего",
      summary: "Сводка.",
      date: "9999-01-01T00:00:00.000Z",
    });
    // До правки: 200 ok, и материал занимал верх ленты бессрочно.
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("date_out_of_range");
  });

  test("дата раньше генезис-блока биткоина тоже вне диапазона", async () => {
    const r = await post("digests", {
      title: "Дайджест из прошлого века",
      summary: "Сводка.",
      date: "1970-01-01T00:00:00.000Z",
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("date_out_of_range");
  });

  test("неразбираемая строка — 400, а не текущее время", async () => {
    // «12.08.2026» здесь особенно важна: Date.parse в этом рантайме отвечает
    // на неё не ошибкой, а восьмым декабря — то есть европейская запись молча
    // становилась американской. Поэтому форма требуется ISO-8601.
    for (const date of ["вчера", "12.08.2026", "не дата", "Aug 12 2026"]) {
      const r = await post("digests", {
        title: `Дайджест с датой «${date}»`,
        summary: "Сводка.",
        date,
      });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("invalid_date");
    }
  });

  test("не строка — тоже 400", async () => {
    const r = await post("digests", {
      title: "Дайджест с числовой датой",
      summary: "Сводка.",
      date: 1_754_000_000_000,
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_date");
  });

  test("поля нет — по-прежнему «сейчас»", async () => {
    // Осмысленный дефолт; ломать его находка не просила.
    const before = Date.now() - 1000;
    const r = await post("digests", { title: "Дайджест без даты", summary: "Сводка." });
    expect(r.status).toBe(200);
    const stored = db.getDigest(String(r.json.id))!;
    expect(Date.parse(stored.date)).toBeGreaterThanOrEqual(before);
  });

  test("нормальная дата сохраняется как есть", async () => {
    const r = await post("digests", {
      title: "Дайджест с нормальной датой",
      summary: "Сводка.",
      date: DAY,
    });
    expect(r.status).toBe(200);
    expect(db.getDigest(String(r.json.id))?.date).toBe(DAY);
  });

  test("у активностей граница та же", async () => {
    const bad = await post("activities", {
      project: "TestNet",
      title: "Гайд с датой из будущего",
      date: "9999-01-01T00:00:00.000Z",
    });
    expect(bad.status).toBe(400);

    // Дедлайн через полгода — законный случай, его трогать нельзя.
    const soon = new Date(Date.now() + 180 * 24 * 3600_000).toISOString();
    const ok = await post("activities", {
      project: "TestNet",
      title: "Гайд с дедлайном через полгода",
      date: soon,
    });
    expect(ok.status).toBe(200);
  });
});
