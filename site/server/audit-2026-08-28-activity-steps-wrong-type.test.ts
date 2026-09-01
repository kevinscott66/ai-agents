/**
 * Аудит 2026-08-28: `steps` не-массивом стирали содержимое гайда молча.
 *
 * `toStringArray` на любом не-массиве возвращает `[]` (index.ts:1285), а
 * вызывался он по условию `b.steps !== undefined`. То есть строка со списком
 * шагов, `null` или объект доезжали до БД как ЯВНАЯ ОЧИСТКА и выносили шаги —
 * главное содержимое гайда. Счётчик потерь при этом оставался нулём, потому
 * что считается он через `Array.isArray(b.steps)`: ни warn в логе, ни поля в
 * ответе. Отправитель видел `ok:true`.
 *
 * Инвариант тот же, что у дайджестов после аудита 2026-08-28 (items):
 * поле, которое не удалось прочитать как массив, считается НЕ присланным —
 * сохранённое не трогаем. Явная очистка осталась за `[]`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-act-wrongtype-"));
process.env.SITE_DB_PATH = join(TMP, "act.db");
process.env.SITE_INGEST_TOKEN = "act-wrongtype-token";

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

type IngestRes = {
  ok: boolean;
  id: string;
  steps: number;
  droppedSteps?: number;
  ignoredFields?: string[];
};

async function ingest(body: unknown): Promise<IngestRes> {
  const r = await fetch(`${base}/api/internal/activities`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer act-wrongtype-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as IngestRes;
}

const STEPS = ["Подключить кошелёк", "Сделать своп", "Забрать поинты"];
const TAGS = ["#airdrop", "#testnet"];

async function seed(id: string): Promise<void> {
  const res = await ingest({
    id,
    project: "Проект",
    title: `Гайд ${id}`,
    steps: STEPS,
    hashtags: TAGS,
  });
  expect(res.steps).toBe(3);
}

describe("нечитаемый тип поля не стирает сохранённое", () => {
  test("строка вместо массива шагов оставляет шаги на месте", async () => {
    await seed("a-str");
    const res = await ingest({
      id: "a-str",
      project: "Проект",
      title: "Гайд a-str",
      steps: "1. Подключить кошелёк\n2. Сделать своп",
    });
    expect(getActivity("a-str")?.steps).toEqual(STEPS);
    expect(res.steps).toBe(3);
  });

  test("null вместо массива шагов тоже не очищает", async () => {
    await seed("a-null");
    await ingest({ id: "a-null", project: "Проект", title: "Гайд a-null", steps: null });
    expect(getActivity("a-null")?.steps).toEqual(STEPS);
  });

  test("объект вместо массива хэштегов не очищает", async () => {
    await seed("a-obj");
    await ingest({
      id: "a-obj",
      project: "Проект",
      title: "Гайд a-obj",
      hashtags: { "0": "#airdrop" },
    });
    expect(getActivity("a-obj")?.hashtags).toEqual(TAGS);
  });

  test("о непонятом поле сообщают, а не молчат", async () => {
    await seed("a-loud");
    const res = await ingest({
      id: "a-loud",
      project: "Проект",
      title: "Гайд a-loud",
      steps: "не массив",
      hashtags: 42,
    });
    expect(res.ignoredFields).toEqual(["steps", "hashtags"]);
  });

  test("на новой активности нечитаемое поле даёт пустой список, а не падение", async () => {
    const res = await ingest({
      id: "a-new",
      project: "Проект",
      title: "Гайд a-new",
      steps: "не массив",
    });
    expect(res.ok).toBe(true);
    expect(getActivity("a-new")?.steps).toEqual([]);
    expect(res.ignoredFields).toEqual(["steps"]);
  });
});

describe("прежние правила остались", () => {
  test("явный пустой массив по-прежнему очищает", async () => {
    await seed("b-clear");
    const res = await ingest({
      id: "b-clear",
      project: "Проект",
      title: "Гайд b-clear",
      steps: [],
      hashtags: [],
    });
    expect(getActivity("b-clear")?.steps).toEqual([]);
    expect(getActivity("b-clear")?.hashtags).toEqual([]);
    expect(res.steps).toBe(0);
    expect(res.ignoredFields).toBeUndefined();
  });

  test("отсутствие поля не трогает сохранённое и молчит", async () => {
    await seed("b-absent");
    const res = await ingest({ id: "b-absent", project: "Проект", title: "Гайд b-absent" });
    expect(getActivity("b-absent")?.steps).toEqual(STEPS);
    expect(res.steps).toBe(3);
    expect(res.ignoredFields).toBeUndefined();
  });

  test("массив с мусором внутри по-прежнему считается потерей пунктов", async () => {
    await seed("b-partial");
    const res = await ingest({
      id: "b-partial",
      project: "Проект",
      title: "Гайд b-partial",
      steps: ["Только этот", 7, "", null],
    });
    expect(getActivity("b-partial")?.steps).toEqual(["Только этот"]);
    expect(res.droppedSteps).toBe(3);
    expect(res.ignoredFields).toBeUndefined();
  });

  test("нормальные массивы обновляются как прежде", async () => {
    await seed("b-ok");
    await ingest({
      id: "b-ok",
      project: "Проект",
      title: "Гайд b-ok",
      steps: ["Новый шаг"],
      hashtags: ["#новый"],
    });
    expect(getActivity("b-ok")?.steps).toEqual(["Новый шаг"]);
    expect(getActivity("b-ok")?.hashtags).toEqual(["#новый"]);
  });
});
