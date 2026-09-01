/**
 * SCHEDULE_POST: владелец календаря и честность обещания (аудит 2026-08-04).
 *
 * Две находки в одном действии.
 *
 * 1. Публикатора нет. `content_calendar` пишется ровно одним местом и читается
 *    двумя (LIST/CANCEL); статус 'sent' и колонка sent_at встречаются только в
 *    миграции 022 — их никто не проставляет, ни один планировщик таблицу не
 *    сканирует. При этом описание инструмента обещало «запланировать отправку
 *    контента в канал», и модель по ok:true рапортовала в чат, что пост уйдёт
 *    в назначенное время. Он не уходил никогда.
 *
 *    Чинится обещание, а не поведение: автономная публикация в канал без
 *    человека в контуре в этом проекте запрещена (постинг идёт через
 *    PUBLISH_TO_CHANNEL под апрувом), так что заводить фонового публикатора
 *    по итогам аудита нельзя.
 *
 * 2. Календарь заводил кто угодно. CANCEL_SCHEDULED_POST ограничен
 *    smm/orchestrator, и его комментарий ссылается на «SCHEDULE_POST
 *    ownership: only smm/orchestrator» — которого не существовало. Любая из 12
 *    ролей могла создать запись, а перечислить и снять её могли только двое.
 */
import { describe, test, expect } from "bun:test";
import { handleSchedulePost } from "../lib/dispatch/misc.ts";
import { ROLE_EXPOSED_TOOLS } from "../lib/permissions.ts";
import { TOOLS } from "../lib/tools-schema.ts";
import { db } from "../lib/db.ts";

const CHAT = -77321;

function ctx(agentKey: string) {
  return {
    agentKey,
    chatId: CHAT,
    resolveUserbot: async () => null,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    channel: "@test_channel",
    content: "текст поста",
    scheduledAt: Date.now() + 3_600_000,
    ...overrides,
  } as never;
}

describe("владелец календаря — smm и orchestrator", () => {
  for (const role of ["smm", "orchestrator"]) {
    test(`${role} заводит запись`, () => {
      const r = handleSchedulePost(payload(), ctx(role));
      expect(r.ok).toBe(true);
      if (r.ok) {
        db.prepare(`DELETE FROM content_calendar WHERE id = ?`).run(
          (r.result as { id: string }).id,
        );
      }
    });
  }

  for (const role of ["copy", "design", "backend", "perm"]) {
    test(`${role} получает отказ`, () => {
      const r = handleSchedulePost(payload(), ctx(role));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/forbidden/);
    });
  }

  test("отказ происходит ДО записи в БД", () => {
    // Иначе проверка роли была бы косметикой: строка уже в календаре, а
    // вызывающий видит ошибку и не знает её id — снять такую запись он не
    // может, LIST ему тоже закрыт.
    const before = db
      .prepare(`SELECT count(*) AS n FROM content_calendar WHERE chat_id = ?`)
      .get(CHAT) as { n: number };
    handleSchedulePost(payload(), ctx("copy"));
    const after = db
      .prepare(`SELECT count(*) AS n FROM content_calendar WHERE chat_id = ?`)
      .get(CHAT) as { n: number };
    expect(after.n).toBe(before.n);
  });

  test("экспозиция на уровне промпта совпадает с CANCEL", () => {
    expect(ROLE_EXPOSED_TOOLS.SCHEDULE_POST).toEqual(
      ROLE_EXPOSED_TOOLS.CANCEL_SCHEDULED_POST,
    );
  });
});

describe("инструмент не обещает того, чего не делает", () => {
  const tool = TOOLS.find((t) => t.name === "SCHEDULE_POST")!;

  test("описание прямо говорит, что отправки нет", () => {
    // Когда/если публикатор появится — этот тест обязан упасть, чтобы обещание
    // и реальность меняли вместе, а не по отдельности.
    expect(tool.description).toMatch(/НЕ отправляет/);
    expect(tool.description).toMatch(/PUBLISH_TO_CHANNEL/);
  });

  test("результат несёт autoPublish:false и пояснение", () => {
    const r = handleSchedulePost(payload(), ctx("smm"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.result as {
      id: string;
      status: string;
      autoPublish: boolean;
      note: string;
    };
    expect(res.autoPublish).toBe(false);
    expect(res.note).toContain("PUBLISH_TO_CHANNEL");
    // Метка статуса совпадает со строкой в БД и с выдачей LIST — расхождение
    // сбивало бы модель сильнее, чем помогало.
    const row = db
      .prepare(`SELECT status FROM content_calendar WHERE id = ?`)
      .get(res.id) as { status: string };
    expect(res.status).toBe(row.status);
    db.prepare(`DELETE FROM content_calendar WHERE id = ?`).run(res.id);
  });

  test("время в прошлом отвергается", () => {
    const r = handleSchedulePost(
      payload({ scheduledAt: Date.now() - 1000 }),
      ctx("smm"),
    );
    expect(r.ok).toBe(false);
  });
});
