/**
 * Аудит 2026-08-20: присланный `id` обходил защиту от затирания страниц.
 *
 * `freeSlug` существует ровно затем, чтобы новый материал не сел на слаг
 * чужого: предикат `taken` сравнивает заголовок (у активностей — ещё и
 * проект) и при несовпадении отходит на `-2`, `-3`, … Но проверка стояла
 * только на ПРОИЗВОДНОМ слаге. Явный `id` в теле «уважался как есть» и уходил
 * прямиком в `upsertDigest`/`upsertActivity`, где стоит
 * `ON CONFLICT(id) DO UPDATE` — то есть подменял уже опубликованную страницу
 * другим материалом, отвечая 200 ok.
 *
 * Почему это не косметика: DELETE-роута у сайта нет, версий страниц нет, RSS
 * к моменту подмены уже ушёл. Откатывать нечем — ровно та беспомощность, что
 * стоила восьми страниц в T-743. Сегодня ни один отправитель `id` не шлёт, но
 * эндпоинт его рекламирует (на кривом отвечает 400 `invalid_id`), а тело
 * ингеста пишет модель.
 *
 * Инвариант: тот же материал под тем же id — обновление (200); ДРУГОЙ материал
 * под занятым id — отказ (409), а страница остаётся прежней.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-explicit-id-"));
process.env.SITE_DB_PATH = join(TMP, "explicit-id.db");
process.env.SITE_INGEST_TOKEN = "explicit-id-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");
const db = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

// Счётчик лимитера общий на процесс — см. ingest-slug.test.ts.
beforeEach(() => _resetRateLimiter());

async function post(kind: "digests" | "activities", body: unknown) {
  const r = await fetch(`${base}/api/internal/${kind}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer explicit-id-token",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

const DAY = "2026-08-20T09:00:00.000Z";

describe("дайджесты: явный id не затирает чужую страницу", () => {
  const ID = "2026-08-20-занятый-слаг";

  test("чужой материал под занятым id → 409, страница не тронута", async () => {
    const first = await post("digests", {
      id: ID,
      title: "Итоги недели: что произошло",
      summary: "Первая, настоящая статья.",
      date: DAY,
    });
    expect(first.status).toBe(200);
    expect(first.json.id).toBe(ID);

    const second = await post("digests", {
      id: ID,
      title: "Совершенно другая статья",
      summary: "Материал, который не должен подменить первый.",
      date: DAY,
    });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("id_taken");

    const row = db.getDigest(ID);
    expect(row?.title).toBe("Итоги недели: что произошло");
    expect(row?.summary).toBe("Первая, настоящая статья.");
  });

  test("тот же материал под тем же id — обновление, а не отказ", async () => {
    // Иначе правка опечатки в уже опубликованной статье станет невозможной.
    const again = await post("digests", {
      id: ID,
      title: "Итоги недели: что произошло",
      summary: "Аннотацию поправили после публикации.",
      date: DAY,
    });
    expect(again.status).toBe(200);
    expect(db.getDigest(ID)?.summary).toBe("Аннотацию поправили после публикации.");
  });

  test("свободный явный id по-прежнему принимается", async () => {
    const r = await post("digests", {
      id: "2026-08-20-свободный-слаг",
      title: "Третья статья",
      summary: "Ничего не занимает.",
      date: DAY,
    });
    expect(r.status).toBe(200);
    expect(r.json.id).toBe("2026-08-20-свободный-слаг");
  });

  test("кривой id по-прежнему 400, а не 409 — тело невалидно", async () => {
    const r = await post("digests", {
      id: "нельзя пробелы и СЛЭШ/",
      title: "Четвёртая статья",
      summary: "Проверка порядка проверок.",
      date: DAY,
    });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_id");
  });
});

describe("активности: та же защита, тот же предикат", () => {
  const ID = "monad-занятый-гайд";

  test("другой проект под занятым id → 409, гайд не подменён", async () => {
    const first = await post("activities", {
      id: ID,
      project: "Monad",
      title: "Тестнет: базовые шаги",
      date: DAY,
      steps: ["Подключить кошелёк"],
    });
    expect(first.status).toBe(200);

    const second = await post("activities", {
      id: ID,
      project: "Scroll",
      title: "Тестнет: базовые шаги",
      date: DAY,
      steps: ["Совсем другой гайд"],
    });
    expect(second.status).toBe(409);
    expect(second.json.error).toBe("id_taken");

    const row = db.getActivity(ID);
    expect(row?.project).toBe("Monad");
    expect(row?.steps?.[0]).toBe("Подключить кошелёк");
  });

  test("тот же проект и заголовок — обновление проходит", async () => {
    const r = await post("activities", {
      id: ID,
      project: "Monad",
      title: "Тестнет: базовые шаги",
      date: DAY,
      steps: ["Подключить кошелёк", "Получить тестовые токены"],
    });
    expect(r.status).toBe(200);
    expect(db.getActivity(ID)?.steps).toHaveLength(2);
  });
});
