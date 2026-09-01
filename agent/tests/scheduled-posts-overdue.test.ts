/**
 * Аудит 2026-08-13: LIST_SCHEDULED_POSTS показывал просроченное как будущее и
 * со временем переставал показывать будущее вовсе.
 *
 * Два факта, каждый по отдельности безобидный. Первый: публикатора в проекте
 * нет — статус 'sent' и колонка sent_at существуют только в миграции 022, ни
 * один планировщик таблицу не сканирует (это уже зафиксировано аудитом
 * 2026-08-04 в schedule-post-honesty.test.ts). Второй: из 'scheduled' строка не
 * уходит сама никак — GC у таблицы нет, в ARCHIVE_SPECS её нет, только в
 * STAT_TABLES db-maint.
 *
 * Вместе они дают отказ, а не мусор. Выдача была
 * `ORDER BY scheduled_at ASC LIMIT 50` без отсечки по времени, то есть окно
 * забирало 50 САМЫХ СТАРЫХ записей. После полусотни просроченных инструмент
 * перестаёт показывать будущие посты вообще — вытесняются ровно те, ради
 * которых его зовут.
 *
 * Плюс метка: строка со вчерашней датой и статусом 'scheduled' читается моделью
 * как «запланировано и уйдёт», хотя не уйдёт и не ушло.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { executeTool } from "../lib/tools-schema.ts";
import { db } from "../lib/db.ts";

const CHAT = -88451;
const OTHER_CHAT = -88452;
const HOUR = 3_600_000;

/**
 * То же, но время задаётся абсолютной меткой: совпадение до миллисекунды
 * нужно задать точно, а `Date.now()` внутри seed() у двух вызовов разный.
 */
function seedAt(id: string, at: number, chatId = CHAT, channel = "@a") {
  db.prepare(
    `INSERT INTO content_calendar(id, channel, scheduled_at, payload, status, created_at, chat_id)
     VALUES (?, ?, ?, '{}', 'scheduled', 1, ?)`,
  ).run(id, channel, at, chatId);
}

function seed(id: string, atOffsetMs: number, chatId = CHAT, channel = "@a") {
  db.prepare(
    `INSERT INTO content_calendar(id, channel, scheduled_at, payload, status, created_at, chat_id)
     VALUES (?, ?, ?, '{}', 'scheduled', 1, ?)`,
  ).run(id, channel, Date.now() + atOffsetMs, chatId);
}

function wipe() {
  db.prepare("DELETE FROM content_calendar WHERE id LIKE 'ovd-%'").run();
}

async function list(input: Record<string, unknown> = {}) {
  return JSON.parse(
    await executeTool("LIST_SCHEDULED_POSTS", input, {
      agentKey: "smm",
      chatId: CHAT,
    } as never),
  );
}

beforeEach(wipe);
afterAll(wipe);

describe("просроченное не вытесняет будущее", () => {
  test("будущий пост виден, даже когда просроченных больше, чем окно выдачи", async () => {
    // 60 просроченных — заведомо больше LIMIT 50.
    for (let i = 0; i < 60; i++) seed(`ovd-past-${i}`, -(i + 2) * HOUR);
    seed("ovd-future", +5 * HOUR);

    const out = await list();

    // До правки окно целиком забирали самые старые, и этой записи в нём не было.
    expect(out.posts.map((p: { id: string }) => p.id)).toContain("ovd-future");
    // И она первая: неактуальное уходит в хвост, а не в голову.
    expect(out.posts[0].id).toBe("ovd-future");
  });

  test("несколько будущих идут по возрастанию времени и все впереди просроченных", async () => {
    seed("ovd-past-a", -3 * HOUR);
    seed("ovd-soon", +1 * HOUR);
    seed("ovd-later", +9 * HOUR);

    const out = await list();

    expect(out.posts.map((p: { id: string }) => p.id)).toEqual([
      "ovd-soon",
      "ovd-later",
      "ovd-past-a",
    ]);
  });
});

describe("просроченное названо просроченным", () => {
  test("overdue проставлен по времени, а не по статусу", async () => {
    seed("ovd-past-b", -2 * HOUR);
    seed("ovd-future-b", +2 * HOUR);

    const out = await list();
    const byId = Object.fromEntries(
      out.posts.map((p: { id: string; overdue: boolean; status: string }) => [p.id, p]),
    );

    // Статус у обеих строк одинаковый — из него правду не достать.
    expect(byId["ovd-past-b"].status).toBe("scheduled");
    expect(byId["ovd-future-b"].status).toBe("scheduled");
    expect(byId["ovd-past-b"].overdue).toBe(true);
    expect(byId["ovd-future-b"].overdue).toBe(false);
  });

  test("счётчик просроченных считает всё, а не только попавшее в окно", async () => {
    for (let i = 0; i < 55; i++) seed(`ovd-past-${i}`, -(i + 2) * HOUR);

    const out = await list();

    expect(out.count).toBe(50); // окно
    expect(out.overdue_count).toBe(55); // весь хвост
  });

  test("при просроченных есть словесное предупреждение", async () => {
    seed("ovd-past-c", -2 * HOUR);

    const out = await list();

    expect(out.note).toContain("не были отправлены");
    expect(out.note).toContain("автопубликации");
  });

  test("без просроченных предупреждения нет", async () => {
    seed("ovd-future-c", +2 * HOUR);

    const out = await list();

    expect(out.overdue_count).toBe(0);
    expect(out.note).toBeUndefined();
    expect(out.posts[0].overdue).toBe(false);
  });
});

describe("здоровые пути не тронуты", () => {
  test("chat-скоуп сохранён: чужие записи не видны и не считаются", async () => {
    seed("ovd-past-mine", -2 * HOUR);
    seed("ovd-past-theirs", -3 * HOUR, OTHER_CHAT);
    seed("ovd-future-theirs", +3 * HOUR, OTHER_CHAT);

    const out = await list();

    const ids = out.posts.map((p: { id: string }) => p.id);
    expect(ids).toContain("ovd-past-mine");
    expect(ids).not.toContain("ovd-past-theirs");
    expect(ids).not.toContain("ovd-future-theirs");
    // Счётчик берёт тот же скоуп, что и выборка, — иначе он бы «протекал».
    expect(out.overdue_count).toBe(1);
  });

  test("фильтр по каналу сохранён и распространяется на счётчик", async () => {
    seed("ovd-past-a1", -2 * HOUR, CHAT, "@a");
    seed("ovd-past-b1", -3 * HOUR, CHAT, "@b");
    seed("ovd-future-a1", +2 * HOUR, CHAT, "@a");

    const out = await list({ channel: "@b" });

    expect(out.posts.map((p: { id: string }) => p.id)).toEqual(["ovd-past-b1"]);
    expect(out.overdue_count).toBe(1);
  });

  test("отменённые по-прежнему не показываются", async () => {
    seed("ovd-past-d", -2 * HOUR);
    db.prepare("UPDATE content_calendar SET status='cancelled' WHERE id='ovd-past-d'").run();

    const out = await list();

    expect(out.ok).toBe(true);
    expect(out.count).toBe(0);
    expect(out.overdue_count).toBe(0);
  });

  test("пустой календарь — прежняя форма ответа", async () => {
    const out = await list();

    expect(out.ok).toBe(true);
    expect(out.count).toBe(0);
    expect(out.posts).toEqual([]);
  });
});

/*
 * Аудит 2026-08-29: ключ сортировки не был полным.
 *
 * SCHEDULE_POST принимает время с точностью до минуты, так что два поста на
 * одну минуту — обычное дело, а не экзотика. Для них обе части ключа
 * ((scheduled_at < now) и ABS(scheduled_at - now)) совпадали, и порядок
 * оставался на усмотрение SQLite: он не обещан и меняется от плана запроса.
 * На границе LIMIT 50 это уже не косметика — от произвольного порядка зависит,
 * какая из строк вообще попадёт в выдачу, а модель дальше отменяет пост по id
 * из неё.
 */
describe("порядок выдачи не зависит от удачи", () => {
  test("посты на одну и ту же минуту идут по id, а не как придётся", async () => {
    const at = Date.now() + 4 * HOUR;
    // Вставляем вперемешку: если бы выдача шла по порядку вставки (rowid),
    // тест прошёл бы и без правки.
    seedAt("ovd-tie-c", at);
    seedAt("ovd-tie-a", at);
    seedAt("ovd-tie-b", at);

    const ids = (await list()).posts.map((p: { id: string }) => p.id);
    expect(ids).toEqual(["ovd-tie-a", "ovd-tie-b", "ovd-tie-c"]);
  });

  test("на границе окна выдачи набор один и тот же от вызова к вызову", async () => {
    // 55 строк на одну метку — больше LIMIT 50, то есть пятеро не поместятся.
    // Кто именно, должно решаться правилом, а не планом запроса.
    const at = Date.now() + 6 * HOUR;
    for (let i = 0; i < 55; i++) seedAt(`ovd-tie-${String(i).padStart(2, "0")}`, at);

    const first = (await list()).posts.map((p: { id: string }) => p.id);
    const second = (await list()).posts.map((p: { id: string }) => p.id);

    expect(first).toHaveLength(50);
    expect(second).toEqual(first);
    // Отсечка идёт по тому же правилу: остались первые пятьдесят по id.
    expect(first.at(-1)).toBe("ovd-tie-49");
  });
});
