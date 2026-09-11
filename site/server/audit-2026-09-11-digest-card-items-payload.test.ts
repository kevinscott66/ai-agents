/**
 * Аудит 2026-09-11, круг 51: в проекции карточки дайджеста осталась колонка,
 * которую список не показывает, — и она же в этой проекции самая тяжёлая.
 *
 * Аудит 2026-08-20 сузил списочные ручки с `SELECT *` до DIGEST_CARD_COLUMNS
 * ровно одним доводом: «фронт `body` в списке не читает ни разу». Довод верен
 * дословно и для `items_json`, которое тогда в список колонок попало:
 *
 *   - карточка (`DigestCard` в web/src/sections/DigestsSection.tsx) читает
 *     title, date, summary и sourceCount — количество источников приезжает
 *     отдельным числом, сами источники ей не нужны;
 *   - `data.items` разворачивает только web/src/pages/DigestPage.tsx, а он
 *     ходит в `/api/digests/:id` — там строка полная, через `getDigest`.
 *
 * Цена та же, что была у `body`, и того же порядка. Замер ниже (потолки из
 * INGEST_MAX: 100 дайджестов по limit, 100 пунктов, 1 000 символов текста и
 * 2 000 символов ссылки): анонимный `GET /api/digests?limit=100` собирает
 * примерно 38 МиБ, из которых на видимые карточкой поля приходится около
 * 0,24 МиБ. Сборка — синхронный `JSON.stringify` в единственном потоке Bun.
 *
 * Почему колонка всё-таки осталась. Убрать её — это поменять форму ответа и
 * тип на фронте ОДНОВРЕМЕННО: `Digest.items` в web/src/types.ts объявлен
 * обязательным, и карточка списка типизирована тем же `Digest`. Порознь любая
 * половина ломает контракт: сервер без поля оставляет тип враньём, а `items?:`
 * без правки сервера ничего не чинит. Ровно так и делали с `body` — сервер
 * отдаёт его условно (`...(body ? { body } : {})`), а web объявляет `body?:`,
 * и с `steps`/`whatIs` у активностей, где на фронте заведён отдельный
 * `ActivityCard = Omit<Activity, ...>`.
 *
 * Поэтому здесь, как в proxy-header-trust.test.ts, зафиксирован не факт
 * покрытия, а признанный пробел — вместе с условием, при котором он перестаёт
 * быть пробелом. Станет `items?:` (или появится отдельный тип карточки) —
 * последний тест упадёт и напомнит, что колонку теперь можно убрать.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SERVER_SRC = readFileSync(join(import.meta.dir, "db.ts"), "utf8");
const WEB_TYPES = readFileSync(
  join(import.meta.dir, "..", "web", "src", "types.ts"),
  "utf8",
);
const CARD_SECTION = readFileSync(
  join(import.meta.dir, "..", "web", "src", "sections", "DigestsSection.tsx"),
  "utf8",
);

/** Потолки ingest'а, от которых считается худший случай. Держит тест ниже. */
const MAX = { id: 120, title: 300, summary: 2_000, items: 100, itemText: 1_000, url: 2_000 };
const LIMIT = 100;
const MiB = 1024 * 1024;

function worstCaseCard(withItems: boolean) {
  const item = {
    text: "т".repeat(MAX.itemText),
    url: "https://e.example/" + "u".repeat(MAX.url - "https://e.example/".length),
  };
  return {
    id: "x".repeat(MAX.id),
    title: "t".repeat(MAX.title),
    date: "2026-09-11T00:00:00.000Z",
    summary: "s".repeat(MAX.summary),
    items: withItems ? Array.from({ length: MAX.items }, () => item) : [],
    sourceCount: 10_000,
  };
}

function worstCaseBytes(withItems: boolean): number {
  return Buffer.byteLength(
    JSON.stringify({
      items: Array.from({ length: LIMIT }, () => worstCaseCard(withItems)),
      total: LIMIT,
    }),
  );
}

describe("замер: чего стоит items_json в списке", () => {
  test("потолки, от которых считается замер, те самые", () => {
    // Сорвётся, если INGEST_MAX поменяют: тогда и числа в докблоке не те.
    const index = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const flat = index.replace(/[_\s]/g, "");
    for (const [k, v] of Object.entries(MAX)) {
      expect(flat).toContain(`${k}:${v}`);
    }
  });

  test("худший ответ списка — десятки мегабайт", () => {
    expect(worstCaseBytes(true) / MiB).toBeGreaterThan(30);
  });

  test("без пунктов тот же ответ — доли мегабайта", () => {
    // Не «мало», а «в полтораста раз меньше»: отношение и есть находка.
    expect(worstCaseBytes(false) / MiB).toBeLessThan(1);
    expect(worstCaseBytes(true) / worstCaseBytes(false)).toBeGreaterThan(100);
  });
});

describe("предпосылка находки: список пункты не показывает", () => {
  test("колонка в проекции карточки по-прежнему есть", () => {
    expect(SERVER_SRC).toContain("id, title, date, summary, items_json, source_count");
  });

  test("карточка списка читает счётчик, а не сами пункты", () => {
    // Когда падает: карточка начала показывать источники — находка снята,
    // колонка нужна, и весь этот файл пора удалять.
    expect(CARD_SECTION).toContain("digest.sourceCount");
    expect(CARD_SECTION).not.toContain("digest.items");
  });
});

describe("условие, при котором пробел перестаёт быть пробелом", () => {
  test("`items` на фронте всё ещё обязателен — сервер один поле убрать не может", () => {
    // Когда падает: в web/src/types.ts появилось `items?:` или отдельный тип
    // карточки. Значит, колонку можно убрать из DIGEST_CARD_COLUMNS и отдавать
    // пункты условно — ровно как уже сделано с `body`.
    expect(WEB_TYPES).toContain("items: DigestItem[];");
    expect(WEB_TYPES).toContain("body?: string;");
  });
});
