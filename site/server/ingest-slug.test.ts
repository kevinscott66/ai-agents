/**
 * Аудит 2026-08-12: две разные статьи молча схлопывались в одну.
 *
 * id для ingest, если его не прислали, собирается из заголовка и режется по
 * первым 80 символам (у активностей — 90, и там даже без даты). Кириллица
 * съедает этот лимит мгновенно: у «Итогов недели» отличие живёт в хвосте
 * («часть первая» / «часть вторая»), а хвост отрезан. Дальше `upsertDigest`
 * делает ON CONFLICT DO UPDATE — вторая статья затирает первую, и ingest
 * отвечает 200 ok, то есть команда агентов уверена, что опубликовала обе.
 *
 * Замер до правки (два дайджеста одного дня, заголовки по 102 символа):
 *   POST #1 → 200 {"ok":true,"id":"2026-08-12-итоги-недели-на-крипторынке-…-важно-зна"}
 *   POST #2 → 200 {"ok":true,"id":"2026-08-12-итоги-недели-на-крипторынке-…-важно-зна"}
 *   same id: true / countDigests(): 1
 *   заголовок в БД: «… — часть вторая»   ← первой части больше нет
 * Активности (project+title, 91 символ, РАЗНЫЕ даты):
 *   ACT #1 и ACT #2 → один и тот же id, countActivities(): 1
 *
 * Инвариант: разный текст → разные строки; тот же текст → та же строка
 * (идемпотентность по-прежнему нужна: агент переотправляет статью после правки).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-slug-"));
process.env.SITE_DB_PATH = join(TMP, "slug.db");
process.env.SITE_INGEST_TOKEN = "slug-test-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");
const db = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});

afterAll(() => server.stop(true));

// Счётчик лимитера общий на весь процесс bun test — соседние файлы успевают
// его выбрать, и наши запросы получают 429 вместо 200.
beforeEach(() => _resetRateLimiter());

async function ingest(kind: "digests" | "activities", body: unknown) {
  const r = await fetch(`${base}/api/internal/${kind}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer slug-test-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  const j = (await r.json()) as { ok: boolean; id: string };
  expect(j.ok).toBe(true);
  return j.id;
}

const DAY = "2026-08-12T09:00:00.000Z";
const PREFIX =
  "Итоги недели на крипторынке: биткоин, эфириум, солана, альткоины и всё, что важно знать";

describe("дайджесты: слаг из заголовка", () => {
  test("две статьи одного дня с общим началом — две строки, а не одна", async () => {
    const before = db.countDigests();
    const id1 = await ingest("digests", {
      title: `${PREFIX} — часть первая`,
      summary: "Первая часть недельного обзора.",
      date: DAY,
    });
    const id2 = await ingest("digests", {
      title: `${PREFIX} — часть вторая`,
      summary: "Вторая часть недельного обзора.",
      date: DAY,
    });

    // Старое поведение: id совпадали, вторая статья затирала первую.
    expect(id2).not.toBe(id1);
    expect(db.countDigests()).toBe(before + 2);
    expect(db.getDigest(id1)?.title).toBe(`${PREFIX} — часть первая`);
    expect(db.getDigest(id2)?.title).toBe(`${PREFIX} — часть вторая`);
  });

  test("третья статья с тем же началом тоже находит себе место", async () => {
    const before = db.countDigests();
    const id3 = await ingest("digests", {
      title: `${PREFIX} — часть третья`,
      summary: "Третья часть.",
      date: DAY,
    });
    expect(db.countDigests()).toBe(before + 1);
    expect(db.getDigest(id3)?.title).toBe(`${PREFIX} — часть третья`);
  });

  test("повторная отправка той же статьи обновляет её, а не плодит копии", async () => {
    const body = {
      title: "Что произошло на рынке за сутки",
      summary: "Короткая сводка.",
      date: "2026-07-01T09:00:00.000Z",
    };
    const first = await ingest("digests", body);
    const before = db.countDigests();
    const again = await ingest("digests", {
      ...body,
      summary: "Короткая сводка (уточнили цифры).",
    });
    expect(again).toBe(first);
    expect(db.countDigests()).toBe(before);
    expect(db.getDigest(first)?.summary).toBe("Короткая сводка (уточнили цифры).");
  });

  test("одинаковый заголовок в разные дни — разные статьи (дата в слаге)", async () => {
    const title = "Ежедневная сводка по рынку";
    const a = await ingest("digests", {
      title,
      summary: "За понедельник.",
      date: "2026-07-06T09:00:00.000Z",
    });
    const b = await ingest("digests", {
      title,
      summary: "За вторник.",
      date: "2026-07-07T09:00:00.000Z",
    });
    expect(b).not.toBe(a);
    expect(db.getDigest(a)?.summary).toBe("За понедельник.");
    expect(db.getDigest(b)?.summary).toBe("За вторник.");
  });

  test("явно присланный id уважается как есть", async () => {
    const id = await ingest("digests", {
      id: "ручной-идентификатор-2026",
      title: "Заголовок с ручным id",
      summary: "Тело.",
      date: DAY,
    });
    expect(id).toBe("ручной-идентификатор-2026");
  });
});

const ACT_PREFIX =
  "Мостим токены между сетями и собираем очки в программе лояльности — инструкция";

describe("активности: слаг из проекта и заголовка", () => {
  test("два разных гайда одного проекта — две строки", async () => {
    const before = db.countActivities();
    const id1 = await ingest("activities", {
      project: "LayerZero",
      title: `${ACT_PREFIX} для новичков`,
      date: DAY,
    });
    const id2 = await ingest("activities", {
      project: "LayerZero",
      title: `${ACT_PREFIX} для тех, кто уже мостил`,
      date: "2026-09-01T09:00:00.000Z",
    });

    // Старое поведение: один id на оба гайда, в БД оставался только второй.
    expect(id2).not.toBe(id1);
    expect(db.countActivities()).toBe(before + 2);
    expect(db.getActivity(id1)?.title).toBe(`${ACT_PREFIX} для новичков`);
    expect(db.getActivity(id2)?.title).toBe(`${ACT_PREFIX} для тех, кто уже мостил`);
  });

  test("тот же гайд второй раз — обновление, не дубль", async () => {
    const body = {
      project: "Scroll",
      title: "Как заработать очки в тестнете",
      date: DAY,
    };
    const first = await ingest("activities", body);
    const before = db.countActivities();
    const again = await ingest("activities", { ...body, status: "Идёт" });
    expect(again).toBe(first);
    expect(db.countActivities()).toBe(before);
    expect(db.getActivity(first)?.status).toBe("Идёт");
  });

  test("одинаковый заголовок у разных проектов не конфликтует", async () => {
    const title = "Как получить роль в дискорде";
    const a = await ingest("activities", { project: "Berachain", title });
    const b = await ingest("activities", { project: "Monad", title });
    expect(b).not.toBe(a);
    expect(db.getActivity(a)?.project).toBe("Berachain");
    expect(db.getActivity(b)?.project).toBe("Monad");
  });
});

/**
 * Аудит 2026-08-13: у обеих функций слага запасной хвост был `Date.now()`.
 *
 * `[^\p{L}\p{N}]` выкашивает эмодзи подчистую, так что от «🔥🔥🔥» остаётся
 * пустая строка — а заголовки пишет модель, и «🚀 ЛУНА 🚀» в чистом виде из
 * эмодзи вполне бывает. Дальше id получался разным на каждый вызов: повторная
 * отправка той же статьи после правки не обновляла её, а плодила новую
 * страницу, и по прежнему адресу навсегда оставалась старая версия — прежний
 * id не воспроизводился даже тем же самым телом запроса. Это ровно то, что
 * `freeSlug` рядом специально бережёт.
 */
describe("заголовок без букв и цифр", () => {
  const FIRE = "🔥🔥🔥";
  const ROCKET = "🚀🚀";

  test("дайджест: повторная отправка обновляет, а не плодит", async () => {
    const body = { title: FIRE, summary: "Первая редакция.", date: DAY };
    const first = await ingest("digests", body);
    const before = db.countDigests();
    // Пауза обязательна: старый код брал `Date.now()`, и две отправки внутри
    // одной миллисекунды случайно совпадали по id — тест был бы зелёным и на
    // сломанном коде. Правка после публикации приходит через минуты, не через
    // микросекунды.
    await Bun.sleep(2);
    const again = await ingest("digests", { ...body, summary: "Вторая редакция." });

    // Старое поведение: id разный, в БД две страницы, первая недостижима.
    expect(again).toBe(first);
    expect(db.countDigests()).toBe(before);
    expect(db.getDigest(first)?.summary).toBe("Вторая редакция.");
  });

  test("дайджест: разные эмодзи-заголовки не схлопываются", async () => {
    const a = await ingest("digests", { title: FIRE, summary: "Огонь.", date: DAY });
    const b = await ingest("digests", { title: ROCKET, summary: "Ракета.", date: DAY });
    expect(b).not.toBe(a);
    expect(db.getDigest(a)?.summary).toBe("Огонь.");
    expect(db.getDigest(b)?.summary).toBe("Ракета.");
  });

  test("дайджест: в id нет метки времени", async () => {
    // `Date.now()` оставлял в адресе тринадцатизначное число — по нему видно
    // час публикации с точностью до миллисекунды, и адрес нельзя ни угадать,
    // ни повторить.
    const id = await ingest("digests", { title: FIRE, summary: "Ещё раз.", date: DAY });
    expect(id).not.toMatch(/\d{13}/);
    expect(id.startsWith("2026-08-12-")).toBe(true);
  });

  test("активность: повторная отправка обновляет, а не плодит", async () => {
    const body = { project: "✨", title: ROCKET, status: "Идёт" };
    const first = await ingest("activities", body);
    const before = db.countActivities();
    await Bun.sleep(2); // см. пояснение к дайджестам выше
    const again = await ingest("activities", { ...body, status: "Завершена" });

    expect(again).toBe(first);
    expect(db.countActivities()).toBe(before);
    expect(db.getActivity(first)?.status).toBe("Завершена");
    expect(first).not.toMatch(/\d{13}/);
  });

  test("активность: разные эмодзи — разные строки", async () => {
    const a = await ingest("activities", { project: "✨", title: FIRE });
    const b = await ingest("activities", { project: "✨", title: ROCKET });
    expect(b).not.toBe(a);
  });
});
