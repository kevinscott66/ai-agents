/**
 * Аудит 2026-08-20: `/api/activities` тащил в список весь текст гайда.
 *
 * `listActivities` делал `SELECT *`, а потолки ингеста дают 8 000 символов на
 * `whatIs` и 50 × 2 000 на `steps` — до ~116 КБ на активность и до ~11,6 МБ на
 * ответ при `limit=100` (потолок клампа). Такой ответ собирает синхронный
 * `JSON.stringify` в единственном потоке, где живёт весь сайт: страница
 * «Активности» подвешивала сервер целиком.
 *
 * Карточки этих полей не показывают — ActivitiesSection и HomeActivities
 * берут emoji, project, title, intro, rewardType, status. Полный гайд
 * приходит с `/api/activities/:id`, как и раньше.
 *
 * Тот же класс, что и у дайджестов (`body` в списке), но заметить его труднее:
 * тяжесть размазана по трём полям вместо одного.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "web3puls-actproj-"));
process.env.SITE_DB_PATH = join(TMP, "actproj.db");
process.env.SITE_INGEST_TOKEN = "actproj-test-token";

const { makeFetchHandler, _resetRateLimiter } = await import("./index.ts");

let server: ReturnType<typeof Bun.serve>;
let base: string;

const MARKER = "МЕТКА-ТЯЖЁЛОГО-ПОЛЯ";
const HEAVY = `${MARKER} ${"я".repeat(7_000)}`;
const STEP = `${MARKER}-шаг ${"ш".repeat(1_500)}`;
let id = "";

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: makeFetchHandler() });
  base = `http://localhost:${server.port}`;
  const r = await fetch(`${base}/api/internal/activities`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer actproj-test-token",
    },
    body: JSON.stringify({
      project: "Пробный проект",
      title: "Пробный гайд",
      emoji: "🧪",
      intro: "Короткое вступление — оно карточке нужно.",
      whatIs: HEAVY,
      steps: Array.from({ length: 20 }, () => STEP),
      rewardType: "Аирдроп",
      status: "Подтверждено",
      date: "2026-08-20T09:00:00.000Z",
    }),
  });
  expect(r.status).toBe(200);
  id = ((await r.json()) as { id: string }).id;
});

afterAll(() => server.stop(true));

beforeEach(() => _resetRateLimiter());

describe("/api/activities: список без текста гайда", () => {
  test("карточки не несут whatIs и steps", async () => {
    const r = await fetch(`${base}/api/activities?limit=100`);
    expect(r.status).toBe(200);
    const raw = await r.text();

    // Прямая проверка полезнее структурной: метка ловит поле под любым именем.
    expect(raw).not.toContain(MARKER);

    const body = JSON.parse(raw) as { items: Record<string, unknown>[] };
    const mine = body.items.find((a) => a.id === id);
    expect(mine).toBeDefined();
    expect("whatIs" in mine!).toBe(false);
    expect("steps" in mine!).toBe(false);

    // Всё, чем рисуется карточка, на месте.
    expect(mine!.intro).toBe("Короткое вступление — оно карточке нужно.");
    expect(mine!.project).toBe("Пробный проект");
    expect(mine!.title).toBe("Пробный гайд");
    expect(mine!.emoji).toBe("🧪");
    expect(mine!.rewardType).toBe("Аирдроп");
    expect(mine!.status).toBe("Подтверждено");
  });

  test("одна активность по-прежнему приходит целиком", async () => {
    const r = await fetch(`${base}/api/activities/${encodeURIComponent(id)}`);
    expect(r.status).toBe(200);
    const a = (await r.json()) as { whatIs: string; steps: string[] };
    expect(a.whatIs).toContain(MARKER);
    expect(a.steps.length).toBe(20);
    expect(a.steps[0]).toContain(MARKER);
  });
});
