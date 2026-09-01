/**
 * Аудит 2026-08-28: скаляр не-строкой стирал сохранённое поле гайда.
 *
 * `asStringOpt` считал «не прислали» только `undefined`, а всё остальное
 * гнал через `asString`, который на `null`, числе, массиве и объекте
 * возвращает `""`. Пустая строка не `NULL`, поэтому `CASE WHEN $intro IS
 * NULL` в `upsertActivity` не срабатывал и колонка перезаписывалась пустотой.
 *
 * `null` в этих полях — не экзотика, а обычный выход сериализатора: Python
 * отдаёт `None`, JS — `?? null`, если поле в источнике не заполнено. Id гайда
 * выводится из project+title, то есть повторная отправка и есть штатный путь
 * обновления: один такой POST выносил intro, whatIs, суммы, инвесторов и
 * ссылку. Ответ при этом `200 {ok:true}` без `ignoredFields` и без строки в
 * логе — те есть только у steps/hashtags. Восстановить нечем: DELETE-маршрута
 * и версий у активностей нет.
 *
 * Отдельно `url`: `safeStoredUrl` возвращает `""` для любой строки без
 * `http(s)://`, поэтому опечатка вида `delabs.space/guide` (без схемы) тоже
 * молча снимала ссылку.
 *
 * Тот же класс чинили 2026-08-28 для массивов (index.ts, readArray): поле,
 * которое не удалось прочитать, считается НЕ присланным и попадает в
 * `ignoredFields`. До скаляров правку не довели.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-act-scalar-"));
process.env.SITE_DB_PATH = join(TMP, "act.db");
process.env.SITE_INGEST_TOKEN = "act-scalar-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");
const { getActivity } = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

interface IngestRes {
  ok: boolean;
  id: string;
  steps: number;
  ignoredFields?: string[];
}

async function ingest(body: unknown): Promise<IngestRes> {
  const r = await fetch(`${base}/api/internal/activities`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer act-scalar-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as IngestRes;
}

const FULL = {
  project: "Monad",
  emoji: "🟣",
  intro: "вступление",
  whatIs: "описание проекта",
  steps: ["шаг первый", "шаг второй"],
  raised: "$225M",
  investors: "Paradigm",
  spent: "$0",
  time: "9 мин",
  rewardType: "Аирдроп",
  status: "Потенциальный",
  dateReceive: "TBA",
  url: "https://example.org/monad",
  hashtags: ["#monad"],
  date: "2026-08-28T09:00:00.000Z",
};

async function seed(title: string): Promise<string> {
  const r = await ingest({ ...FULL, title });
  expect(r.steps).toBe(2);
  return r.id;
}

describe("скаляр не-строкой считается неприсланным", () => {
  test("null не стирает сохранённое", async () => {
    const title = "Гайд null";
    const id = await seed(title);
    await ingest({
      project: FULL.project,
      title,
      intro: null,
      whatIs: null,
      raised: null,
      investors: null,
      status: "Завершена",
      date: FULL.date,
    });
    const a = getActivity(id);
    expect(a?.status).toBe("Завершена");
    expect(a?.intro).toBe("вступление");
    expect(a?.whatIs).toBe("описание проекта");
    expect(a?.raised).toBe("$225M");
    expect(a?.investors).toBe("Paradigm");
  });

  test("число, массив и объект тоже не стирают", async () => {
    const title = "Гайд типы";
    const id = await seed(title);
    await ingest({
      project: FULL.project,
      title,
      spent: 0,
      time: ["9 мин"],
      rewardType: { kind: "Аирдроп" },
      emoji: 42,
      dateReceive: true,
      date: FULL.date,
    });
    const a = getActivity(id);
    expect(a?.spent).toBe("$0");
    expect(a?.time).toBe("9 мин");
    expect(a?.rewardType).toBe("Аирдроп");
    expect(a?.emoji).toBe("🟣");
    expect(a?.dateReceive).toBe("TBA");
  });

  test("о непонятом поле сообщают, а не молчат", async () => {
    const title = "Гайд громкий";
    await seed(title);
    const res = await ingest({
      project: FULL.project,
      title,
      intro: null,
      raised: 225,
      date: FULL.date,
    });
    expect(res.ignoredFields).toEqual(["intro", "raised"]);
  });

  test("на новой активности нечитаемый скаляр даёт пустое поле, а не падение", async () => {
    const res = await ingest({
      project: "Новый",
      title: "Гайд новый",
      intro: null,
      date: FULL.date,
    });
    expect(res.ok).toBe(true);
    expect(getActivity(res.id)?.intro).toBe("");
    expect(res.ignoredFields).toEqual(["intro"]);
  });
});

describe("ссылка", () => {
  test("строка без схемы не снимает сохранённую ссылку", async () => {
    const title = "Гайд ссылка";
    const id = await seed(title);
    const res = await ingest({
      project: FULL.project,
      title,
      url: "delabs.space/guide",
      date: FULL.date,
    });
    expect(getActivity(id)?.url).toBe("https://example.org/monad");
    expect(res.ignoredFields).toEqual(["url"]);
  });

  test("явная пустая строка ссылку по-прежнему снимает", async () => {
    const title = "Гайд снятие";
    const id = await seed(title);
    const res = await ingest({
      project: FULL.project,
      title,
      url: "",
      date: FULL.date,
    });
    expect(getActivity(id)?.url).toBe("");
    expect(res.ignoredFields).toBeUndefined();
  });

  test("нормальная ссылка обновляется как прежде", async () => {
    const title = "Гайд обновление";
    const id = await seed(title);
    await ingest({
      project: FULL.project,
      title,
      url: "https://example.org/new",
      date: FULL.date,
    });
    expect(getActivity(id)?.url).toBe("https://example.org/new");
  });
});

describe("прежние правила остались", () => {
  test("явная пустая строка по-прежнему очищает поле", async () => {
    const title = "Гайд очистка";
    const id = await seed(title);
    const res = await ingest({
      project: FULL.project,
      title,
      raised: "",
      date: FULL.date,
    });
    expect(getActivity(id)?.raised).toBe("");
    expect(res.ignoredFields).toBeUndefined();
  });

  test("отсутствие поля не трогает сохранённое и молчит", async () => {
    const title = "Гайд молчание";
    const id = await seed(title);
    const res = await ingest({ project: FULL.project, title, date: FULL.date });
    expect(getActivity(id)?.raised).toBe("$225M");
    expect(res.ignoredFields).toBeUndefined();
  });

  test("обычная строка обновляет поле", async () => {
    const title = "Гайд строка";
    const id = await seed(title);
    await ingest({
      project: FULL.project,
      title,
      raised: "$300M",
      date: FULL.date,
    });
    expect(getActivity(id)?.raised).toBe("$300M");
  });
});
