/**
 * Аудит 2026-09-11: три слепых пятна отложенного поста.
 *
 * 1. Карточка аппрува не показывала СРОК. Владельцу предлагали одобрить
 *    публикацию, не назвав, когда она выйдет: `scheduledAt` — число, а общий
 *    путь выжимки берёт только строковые поля. «Завтра в 10» и «через три
 *    недели» выглядели в очереди одинаково.
 *
 * 2. У `content` не было границы длины, хотя публикуется отложенный пост тем
 *    же PUBLISH_TO_CHANNEL и упрётся в тот же `PUBLISH_TEXT_MAX_RAW` — только
 *    неделей позже и уже после одобрения.
 *
 * 3. Фильтр `LIST_SCHEDULED_POSTS` по каналу отказывал молча: точное равенство
 *    строк при том, что SCHEDULE_POST принимает канал в любом написании.
 *    Пустой ответ читался как «ничего не запланировано», и модель планировала
 *    поверх уже запланированного.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { approvalPreview } from "../lib/approvals.ts";
import { buildPayload, PUBLISH_TEXT_MAX_RAW } from "../lib/dispatch/build-payload.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { handleSchedulePost } from "../lib/dispatch/misc.ts";
import { DELABS_TZ } from "../lib/delabs-text.ts";
import { db } from "../lib/db.ts";

const CHAT = -99711;
const HOUR = 3_600_000;

beforeEach(() => {
  db.prepare("DELETE FROM content_calendar WHERE chat_id = ?").run(CHAT);
});

describe("карточка аппрува называет срок публикации", () => {
  // Полдень 12 сентября 2026 UTC — в московском поясе 15:00 того же дня.
  const NOON_UTC = Date.UTC(2026, 8, 12, 12, 0, 0);

  test("срок виден и стоит перед каналом и текстом", () => {
    const s = approvalPreview("SCHEDULE_POST", {
      channel: "@delabs",
      content: "итоги недели",
      scheduledAt: NOON_UTC,
    });
    expect(s).toContain("когда:");
    expect(s).toContain("12.09.2026");
    expect(s).toContain(DELABS_TZ);
    // Порядок: выжимка режется с конца, и длинный пост вытеснил бы срок.
    expect(s.indexOf("когда:")).toBeLessThan(s.indexOf("@delabs"));
    expect(s.indexOf("@delabs")).toBeLessThan(s.indexOf("итоги недели"));
  });

  test("длинный пост не вытесняет срок из выжимки", () => {
    const s = approvalPreview("SCHEDULE_POST", {
      channel: "@delabs",
      content: "я".repeat(5000),
      scheduledAt: NOON_UTC,
    });
    expect(s).toContain("12.09.2026");
    expect(s.length).toBeLessThanOrEqual(120);
  });

  test("час указан, а не только дата: «завтра в 10» и «завтра в 22» различимы", () => {
    const morning = approvalPreview("SCHEDULE_POST", {
      channel: "@delabs",
      content: "пост",
      scheduledAt: Date.UTC(2026, 8, 12, 7, 0, 0),
    });
    const evening = approvalPreview("SCHEDULE_POST", {
      channel: "@delabs",
      content: "пост",
      scheduledAt: Date.UTC(2026, 8, 12, 19, 0, 0),
    });
    expect(morning).not.toBe(evening);
  });

  test("мусор вместо срока не роняет рендер всего списка", () => {
    // Значение приходит от модели. Intl на Invalid Date бросает RangeError, и
    // одна кривая заявка схлопнула бы весь /approvals.
    for (const bad of [undefined, null, "завтра", NaN, 0, -1, 1e30, 1_789_000]) {
      const s = approvalPreview("SCHEDULE_POST", {
        channel: "@delabs",
        content: "пост",
        scheduledAt: bad,
      });
      expect(s).toContain("когда: не указано");
      expect(s).toContain("пост");
    }
  });
});

describe("длина отложенного поста ограничена так же, как у немедленного", () => {
  const future = () => Date.now() + 2 * HOUR;
  const ctx = { agentKey: "smm" };

  test("пост сверх предела отклоняется на входе, а не через неделю", () => {
    const r = buildPayload("SCHEDULE_POST", {
      channel: "@delabs",
      content: "я".repeat(PUBLISH_TEXT_MAX_RAW + 1),
      scheduledAt: future(),
    }, ctx) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    // Отказ обязан сказать, что делать: сколько символов и какой предел.
    expect(r.error).toContain(String(PUBLISH_TEXT_MAX_RAW));
    expect(r.error).toContain("сократите");
  });

  test("ровно предел проходит", () => {
    const r = buildPayload("SCHEDULE_POST", {
      channel: "@delabs",
      content: "я".repeat(PUBLISH_TEXT_MAX_RAW),
      scheduledAt: future(),
    }, ctx) as { ok: boolean };
    expect(r.ok).toBe(true);
  });

  test("предел тот же, что у PUBLISH_TO_CHANNEL", () => {
    const long = "я".repeat(PUBLISH_TEXT_MAX_RAW + 1);
    const a = buildPayload("PUBLISH_TO_CHANNEL", { channelId: -100, text: long }, ctx) as {
      ok: boolean;
    };
    const b = buildPayload("SCHEDULE_POST", {
      channel: "@delabs",
      content: long,
      scheduledAt: future(),
    }, ctx) as { ok: boolean };
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
  });
});

describe("фильтр по каналу не отказывает молча", () => {
  function schedule(channel: string) {
    const r = handleSchedulePost(
      { channel, content: "пост", scheduledAt: Date.now() + 2 * HOUR } as never,
      { agentKey: "smm", chatId: CHAT } as never,
    ) as { ok: boolean };
    expect(r.ok).toBe(true);
  }

  async function list(channel?: string) {
    return JSON.parse(
      await executeTool("LIST_SCHEDULED_POSTS", channel ? { channel } : {}, {
        agentKey: "smm",
        chatId: CHAT,
      } as never),
    ) as { ok: boolean; total: number; channel_note?: string };
  }

  test("расхождение в написании канала названо вслух", async () => {
    schedule("-1001234567890");
    const r = await list("@delabs");
    expect(r.total).toBe(0);
    expect(r.channel_note).toContain("-1001234567890");
    expect(r.channel_note).toContain("@delabs");
  });

  test("пустое расписание подсказки не получает", async () => {
    const r = await list("@delabs");
    expect(r.total).toBe(0);
    // Здесь постов нет вовсе — «есть, но под другим именем» было бы враньём.
    expect(r.channel_note).toBeUndefined();
  });

  test("совпавший фильтр подсказки не получает", async () => {
    schedule("@delabs");
    const r = await list("@delabs");
    expect(r.total).toBe(1);
    expect(r.channel_note).toBeUndefined();
  });

  test("запрос без фильтра подсказки не получает", async () => {
    schedule("-1001234567890");
    const r = await list();
    expect(r.total).toBe(1);
    expect(r.channel_note).toBeUndefined();
  });
});
