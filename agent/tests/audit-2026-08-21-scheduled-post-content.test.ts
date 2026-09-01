/**
 * Аудит 2026-08-21: LIST_SCHEDULED_POSTS требовал того, чего сам не давал.
 *
 * SCHEDULE_POST кладёт текст поста в content_calendar.payload
 * (`JSON.stringify({ content })`, dispatch/misc.ts). Читателя у столбца не
 * было ни одного: выдача выбирала `id, channel, scheduled_at, status`, две
 * оставшиеся выборки — `COUNT(*)`, а QUERY_DB держит таблицу в денилисте.
 *
 * Дефект не в лишней записи, а в ноте выдачи: при overdue>0 инструмент велит
 * «публикуй заново через PUBLISH_TO_CHANNEL». Для этого нужен текст, а взять
 * его модели неоткуда — просроченная запись может быть недельной давности, её
 * исходного черновика в контексте уже нет. Указание, выполнить которое нечем,
 * модель выполняет выдумкой.
 *
 * Отдавать текст безопасно: выдача сужена до своего чата (`chat_id = ?`,
 * T-722) и до ролей smm/orchestrator (permissions.ts) — ровно тех, кто эту
 * строку и завёл.
 *
 * В проде таблица пуста (0 строк), то есть дефект латентный.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { executeTool } from "../lib/tools-schema.ts";
import { handleSchedulePost } from "../lib/dispatch/misc.ts";
import { db } from "../lib/db.ts";

const CHAT = -99341;
const HOUR = 3_600_000;

function wipe() {
  db.prepare("DELETE FROM content_calendar WHERE chat_id = ?").run(CHAT);
}

/** Заводит запись НАСТОЯЩИМ SCHEDULE_POST, а не INSERT'ом мимо него. */
function schedule(content: string, channel = "@delabs") {
  const r = handleSchedulePost(
    { channel, content, scheduledAt: Date.now() + 2 * HOUR } as never,
    { agentKey: "smm", chatId: CHAT } as never,
  ) as { ok: boolean; result?: { id: string } };
  expect(r.ok).toBe(true);
  return r.result!.id;
}

function makeOverdue(id: string) {
  db.prepare("UPDATE content_calendar SET scheduled_at = ? WHERE id = ?").run(
    Date.now() - HOUR,
    id,
  );
}

async function list() {
  return JSON.parse(
    await executeTool("LIST_SCHEDULED_POSTS", {}, {
      agentKey: "smm",
      chatId: CHAT,
    } as never),
  ) as {
    ok: boolean;
    posts: Array<{
      id: string;
      content: string | null;
      overdue: boolean;
      content_omitted?: boolean;
      content_unreadable?: boolean;
    }>;
    note?: string;
    content_note?: string;
  };
}

beforeEach(wipe);
afterAll(wipe);

describe("текст запланированного поста доходит до выдачи", () => {
  test("content возвращается ровно тот, что положил SCHEDULE_POST", async () => {
    const text = "Новый дроп Zora: минт открыт до пятницы, инструкция в канале.";
    const id = schedule(text);

    const out = await list();

    const row = out.posts.find((p) => p.id === id);
    expect(row).toBeDefined();
    // До правки в строке не было поля content вовсе.
    expect(row!.content).toBe(text);
  });

  test("нота про просроченное больше не отсылает к тексту, которого не отдали", async () => {
    const text = "Гайд по Monad: чек-лист на 5 шагов.";
    const id = schedule(text);
    makeOverdue(id);

    const out = await list();

    // Нота велит «публикуй заново» — значит текст обязан быть в этом же ответе.
    expect(out.note).toContain("публикуй заново через PUBLISH_TO_CHANNEL");
    expect(out.posts.find((p) => p.id === id)!.content).toBe(text);
  });

  test("длинные посты обрезаются по бюджету и обрезка названа вслух", async () => {
    // Три поста по 4000 символов — суммарно больше бюджета выдачи.
    const ids = [0, 1, 2].map((n) => schedule(`${n}`.repeat(4000)));

    const out = await list();

    const withText = out.posts.filter((p) => p.content !== null);
    const hidden = out.posts.filter((p) => p.content_omitted === true);
    expect(ids.length).toBe(3);
    expect(withText.length).toBeGreaterThanOrEqual(1);
    expect(hidden.length).toBeGreaterThanOrEqual(1);
    expect(withText.length + hidden.length).toBe(3);
    // Молчаливый null читался бы как «пост без текста».
    expect(out.content_note ?? "").toContain("content_omitted");
    expect(out.content_note ?? "").toContain("Не сочиняй текст");
  });

  test("битый payload помечается, а не роняет весь список", async () => {
    const good = schedule("Живой текст поста.");
    const bad = schedule("будет испорчен");
    db.prepare("UPDATE content_calendar SET payload = ? WHERE id = ?").run("{не json", bad);

    const out = await list();

    expect(out.ok).toBe(true);
    expect(out.posts.find((p) => p.id === good)!.content).toBe("Живой текст поста.");
    const broken = out.posts.find((p) => p.id === bad)!;
    expect(broken.content).toBeNull();
    expect(broken.content_unreadable).toBe(true);
    expect(out.content_note ?? "").toContain("content_unreadable");
  });
});
