/**
 * Аудит 2026-08-27: повторная отправка гайда стирала его содержимое.
 *
 * У активностей id выводится из проекта и заголовка (`slugFromProjectTitle`),
 * а `freeSlug` намеренно ПЕРЕИСПОЛЬЗУЕТ его при совпадении — то есть отправить
 * тот же гайд второй раз и есть штатный способ его обновить. При этом ингест
 * приводил каждое отсутствующее поле к пустой строке (`asString` возвращал ""
 * и для «поля не было»), а `upsertActivity` писал все семнадцать колонок
 * безусловным `= excluded.<колонка>`. «Не прислали» означало «стереть».
 *
 * POST со сменой одного статуса обнулял описание проекта, шаги, суммы,
 * инвесторов и ссылку — и отвечал `{ok:true}`. Страница /activity/<id>
 * оставалась пустой шапкой.
 *
 * Тот же дефект чинили у дайджестов 2026-08-21 (`upsertDigest`, поле body);
 * до активностей правку не довели.
 *
 * Замер до правки (SITE_DB_PATH во временном каталоге):
 *   после публикации : whatIs="описание проекта", steps=2, raised="$225M"
 *   после реингеста  : whatIs="",                 steps=0, raised=""
 *
 * Инвариант: отсутствие поля не трогает сохранённое, явная пустая строка
 * по-прежнему очищает.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-act-reingest-"));
process.env.SITE_DB_PATH = join(TMP, "act.db");
process.env.SITE_INGEST_TOKEN = "act-reingest-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");
const { getActivity, upsertActivity } = await import("./db.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => _resetRateLimiter());

async function ingest(body: unknown): Promise<{ ok: boolean; id: string; steps: number }> {
  const r = await fetch(`${base}/api/internal/activities`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer act-reingest-token",
    },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as { ok: boolean; id: string; steps: number };
}

const FULL = {
  project: "Monad",
  title: "Гайд по тестнету",
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
  date: "2026-08-27T09:00:00.000Z",
};

describe("ингест активности: отсутствующее поле не стирает сохранённое", () => {
  test("повторная отправка со статусом сохраняет содержимое гайда", async () => {
    const first = await ingest(FULL);
    expect(first.steps).toBe(2);

    const second = await ingest({
      project: FULL.project,
      title: FULL.title,
      status: "Завершено",
      date: FULL.date,
    });
    expect(second.id).toBe(first.id);

    const a = getActivity(first.id);
    expect(a?.status).toBe("Завершено");
    expect(a?.whatIs).toBe("описание проекта");
    expect(a?.steps).toEqual(["шаг первый", "шаг второй"]);
    expect(a?.raised).toBe("$225M");
    expect(a?.investors).toBe("Paradigm");
    expect(a?.url).toBe("https://example.org/monad");
    expect(a?.emoji).toBe("🟣");
    expect(a?.hashtags).toEqual(["#monad"]);
    // Ответ не должен рапортовать «ноль шагов» о гайде, у которого их два.
    expect(second.steps).toBe(2);
  });

  test("явная пустая строка по-прежнему очищает поле", async () => {
    const first = await ingest({ ...FULL, title: "Гайд с очисткой" });
    await ingest({
      project: FULL.project,
      title: "Гайд с очисткой",
      raised: "",
      steps: [],
      date: FULL.date,
    });
    const a = getActivity(first.id);
    expect(a?.raised).toBe("");
    expect(a?.steps).toEqual([]);
    // Не запрошенное к очистке — на месте.
    expect(a?.whatIs).toBe("описание проекта");
  });

  test("upsertActivity: новая строка получает дефолты, а не NULL", () => {
    upsertActivity({
      id: "act-minimal",
      project: "P",
      title: "T",
      date: "2026-08-27T00:00:00.000Z",
    });
    const a = getActivity("act-minimal");
    expect(a).not.toBeNull();
    expect(a?.whatIs).toBe("");
    expect(a?.steps).toEqual([]);
    expect(a?.hashtags).toEqual([]);
    expect(a?.url).toBe("");
  });
});
