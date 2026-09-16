/**
 * Напоминания: CREATE_REMINDER / LIST_REMINDERS / CANCEL_REMINDER и доставка.
 *
 * Что закрепляем:
 *  - разбор `at` (ISO со смещением, без смещения = МСК) и окно «будущее, не
 *    дальше года» — и в buildPayload, и в хранилище;
 *  - адресат — только чат-источник: chatId из инпута модели игнорируется,
 *    публичный канал отвергается и при создании, и при доставке;
 *  - список и отмена видят только свой чат;
 *  - доставка ровно один раз: повторный проход, «второй процесс» и рестарт
 *    посреди отправки не дают дубля;
 *  - пропущенное за простой уходит один раз с пометкой об опоздании.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { buildPayload } from "../lib/dispatch/build-payload.ts";
import { delabsChannelId } from "../lib/delabs-env.ts";
import {
  cancelReminder,
  checkReminderWindow,
  createReminder,
  deliverDueReminders,
  formatMsk,
  getReminder,
  isoMsk,
  listReminders,
  MAX_ATTEMPTS,
  parseReminderAt,
  SENDING_STALE_MS,
  startReminderScheduler,
  type ReminderSender,
} from "../lib/reminders.ts";

const CHAT_A = -1_000_900_001;
const CHAT_B = -1_000_900_002;
const CTX = { agentKey: "orchestrator", chatId: CHAT_A };
const MIN = 60_000;
const HOUR = 60 * MIN;

type Sent = { chatId: number; text: string; agentKey: string };

function recorder(): { sent: Sent[]; send: ReminderSender } {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (chatId, text, agentKey) => {
      sent.push({ chatId, text, agentKey });
      return { message_id: sent.length };
    },
  };
}

/** Напоминание, чей срок наступил `agoMs` назад (создано ещё раньше). */
function seedDue(chatId: number, text: string, agoMs: number, now = Date.now()) {
  const remindAt = now - agoMs;
  const res = createReminder({
    chatId,
    agentKey: "orchestrator",
    text,
    remindAt,
    now: remindAt - HOUR,
  });
  if (!res.ok) throw new Error(res.error);
  return res.reminder;
}

beforeEach(() => {
  db.prepare("DELETE FROM reminders").run();
});
afterEach(() => {
  db.prepare("DELETE FROM reminders").run();
});

describe("parseReminderAt", () => {
  test("без смещения — московское время (UTC+3)", () => {
    const r = parseReminderAt("2027-03-05 20:00");
    expect(r).toEqual({ ok: true, at: Date.UTC(2027, 2, 5, 17, 0, 0) });
    const t = parseReminderAt("2027-03-05T20:00:30");
    expect(t).toEqual({ ok: true, at: Date.UTC(2027, 2, 5, 17, 0, 30) });
  });

  test("явное смещение и Z уважаются", () => {
    expect(parseReminderAt("2027-03-05T20:00:00+03:00")).toEqual({
      ok: true,
      at: Date.UTC(2027, 2, 5, 17, 0, 0),
    });
    expect(parseReminderAt("2027-03-05T20:00:00Z")).toEqual({
      ok: true,
      at: Date.UTC(2027, 2, 5, 20, 0, 0),
    });
    expect(parseReminderAt("2027-03-05T20:00-0130")).toEqual({
      ok: true,
      at: Date.UTC(2027, 2, 5, 21, 30, 0),
    });
  });

  test("мусор, несуществующие даты и не-строки отвергаются", () => {
    for (const bad of [
      "",
      "   ",
      "завтра в 8",
      "05.03.2027 20:00",
      "2027-02-30 10:00",
      "2027-03-05 25:00",
      "2027-03-05 20:61",
      "2027-03-05T20:00+15:00",
      1_800_000_000_000,
      null,
      {},
    ]) {
      expect(parseReminderAt(bad).ok).toBe(false);
    }
  });

  test("formatMsk / isoMsk показывают московское время", () => {
    const at = Date.UTC(2027, 2, 5, 17, 0, 0);
    expect(formatMsk(at)).toBe("05.03.2027 20:00");
    expect(isoMsk(at)).toBe("2027-03-05T20:00:00+03:00");
  });
});

describe("окно времени", () => {
  const now = Date.UTC(2027, 0, 10, 12, 0, 0);

  test("прошлое и «сейчас» — отказ", () => {
    expect(checkReminderWindow(now - 1, now).ok).toBe(false);
    expect(checkReminderWindow(now, now).ok).toBe(false);
  });

  test("ровно год — можно, дальше — нет", () => {
    const yearAhead = Date.UTC(2028, 0, 10, 12, 0, 0);
    expect(checkReminderWindow(now + MIN, now).ok).toBe(true);
    expect(checkReminderWindow(yearAhead, now).ok).toBe(true);
    const r = checkReminderWindow(yearAhead + 1, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("1 year");
  });
});

describe("buildPayload CREATE_REMINDER / CANCEL_REMINDER", () => {
  const future = () => isoMsk(Date.now() + 2 * HOUR);

  test("валидный инпут → payload с remindAt в мс", () => {
    const at = future();
    const r = buildPayload("CREATE_REMINDER", { text: "  проверить отчёт  ", at }, CTX);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.text).toBe("проверить отчёт");
      expect(r.payload.remindAt).toBe((parseReminderAt(at) as { at: number }).at);
    }
  });

  test("прошлое, больше года, пустой текст, текст-объект, нет at — отказ", () => {
    const past = isoMsk(Date.now() - HOUR);
    const far = isoMsk(Date.now() + 400 * 24 * HOUR);
    expect(buildPayload("CREATE_REMINDER", { text: "x", at: past }, CTX).ok).toBe(false);
    expect(buildPayload("CREATE_REMINDER", { text: "x", at: far }, CTX).ok).toBe(false);
    expect(buildPayload("CREATE_REMINDER", { text: "   ", at: future() }, CTX).ok).toBe(false);
    expect(buildPayload("CREATE_REMINDER", { text: { ru: "x" }, at: future() }, CTX).ok).toBe(
      false,
    );
    expect(buildPayload("CREATE_REMINDER", { text: "x" }, CTX).ok).toBe(false);
    expect(
      buildPayload("CREATE_REMINDER", { text: "x".repeat(2001), at: future() }, CTX).ok,
    ).toBe(false);
  });

  test("CANCEL без id — отказ", () => {
    expect(buildPayload("CANCEL_REMINDER", {}, CTX).ok).toBe(false);
    expect(buildPayload("CANCEL_REMINDER", { id: "  " }, CTX).ok).toBe(false);
  });
});

describe("CREATE_REMINDER через executeTool", () => {
  test("создаёт напоминание в чате вызова", async () => {
    const at = Date.now() + 3 * HOUR;
    const out = JSON.parse(
      await executeTool("CREATE_REMINDER", { text: "созвон с командой", at: isoMsk(at) }, CTX),
    );
    expect(out.ok).toBe(true);
    const id = out.result?.id ?? out.id;
    expect(typeof id).toBe("string");
    const row = getReminder(id)!;
    expect(row.chat_id).toBe(CHAT_A);
    expect(row.agent_key).toBe("orchestrator");
    expect(row.status).toBe("scheduled");
    expect(row.remind_at).toBe(Math.floor(at / 1000) * 1000);
  });

  test("chatId из инпута модели игнорируется: пишется чат-источник", async () => {
    const out = JSON.parse(
      await executeTool(
        "CREATE_REMINDER",
        { text: "проверка пиннинга", at: isoMsk(Date.now() + HOUR), chatId: CHAT_B },
        CTX,
      ),
    );
    expect(out.ok).toBe(true);
    const rows = db.prepare("SELECT chat_id FROM reminders").all() as { chat_id: number }[];
    expect(rows).toEqual([{ chat_id: CHAT_A }]);
  });

  test("время в прошлом — отказ, строка не создаётся", async () => {
    const out = JSON.parse(
      await executeTool("CREATE_REMINDER", { text: "x", at: isoMsk(Date.now() - MIN) }, CTX),
    );
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toContain("past");
    expect((db.prepare("SELECT COUNT(*) AS n FROM reminders").get() as { n: number }).n).toBe(0);
  });

  test("в публичном канале создать нельзя", async () => {
    const out = JSON.parse(
      await executeTool(
        "CREATE_REMINDER",
        { text: "x", at: isoMsk(Date.now() + HOUR) },
        { agentKey: "orchestrator", chatId: delabsChannelId() },
      ),
    );
    expect(out.ok).toBe(false);
    expect((db.prepare("SELECT COUNT(*) AS n FROM reminders").get() as { n: number }).n).toBe(0);
  });

  test("хранилище само тоже отвергает канал, прошлое и нулевой чат", () => {
    const now = Date.now();
    const base = { agentKey: "orchestrator", text: "x", remindAt: now + HOUR, now };
    expect(createReminder({ ...base, chatId: delabsChannelId() }).ok).toBe(false);
    expect(createReminder({ ...base, chatId: 0 }).ok).toBe(false);
    expect(createReminder({ ...base, chatId: CHAT_A, remindAt: now - 1 }).ok).toBe(false);
  });
});

describe("LIST_REMINDERS / CANCEL_REMINDER", () => {
  test("список видит только свой чат, по возрастанию времени", async () => {
    const now = Date.now();
    const mk = (chatId: number, text: string, inMs: number) => {
      const r = createReminder({ chatId, agentKey: "pm", text, remindAt: now + inMs, now });
      if (!r.ok) throw new Error(r.error);
      return r.reminder;
    };
    const later = mk(CHAT_A, "позже", 5 * HOUR);
    const sooner = mk(CHAT_A, "раньше", HOUR);
    mk(CHAT_B, "чужое", 2 * HOUR);

    const out = JSON.parse(await executeTool("LIST_REMINDERS", {}, CTX));
    expect(out.ok).toBe(true);
    expect(out.total).toBe(2);
    expect(out.reminders.map((r: { id: string }) => r.id)).toEqual([sooner.id, later.id]);
    expect(out.reminders[0].text).toBe("раньше");
    expect(out.reminders[0].at).toBe(isoMsk(sooner.remind_at));
    expect(out.reminders[0].overdue).toBe(false);
  });

  test("отмена своего — ок; чужого — как несуществующий, строка не тронута", async () => {
    const now = Date.now();
    const mine = createReminder({ chatId: CHAT_A, agentKey: "pm", text: "a", remindAt: now + HOUR, now });
    const theirs = createReminder({ chatId: CHAT_B, agentKey: "pm", text: "b", remindAt: now + HOUR, now });
    if (!mine.ok || !theirs.ok) throw new Error("seed failed");

    const foreign = JSON.parse(
      await executeTool("CANCEL_REMINDER", { id: theirs.reminder.id, chatId: CHAT_B }, CTX),
    );
    expect(foreign.ok).toBe(false);
    expect(JSON.stringify(foreign)).toContain("no active reminder");
    expect(getReminder(theirs.reminder.id)!.status).toBe("scheduled");

    const own = JSON.parse(await executeTool("CANCEL_REMINDER", { id: mine.reminder.id }, CTX));
    expect(own.ok).toBe(true);
    expect(getReminder(mine.reminder.id)!.status).toBe("cancelled");

    const again = cancelReminder(mine.reminder.id, CHAT_A);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.cause).toBe("not_active");

    const listed = listReminders(CHAT_A);
    expect(listed.total).toBe(0);
  });

  test("отменённое не доставляется", async () => {
    const r = seedDue(CHAT_A, "отменено", MIN);
    expect(cancelReminder(r.id, CHAT_A).ok).toBe(true);
    const rec = recorder();
    const stats = await deliverDueReminders({ send: rec.send });
    expect(rec.sent).toEqual([]);
    expect(stats.sent).toBe(0);
  });
});

describe("доставка", () => {
  test("вовремя: текст без пометки, в чат создания, статус sent", async () => {
    const r = seedDue(CHAT_A, "проверить сборку", 10_000);
    const rec = recorder();
    const stats = await deliverDueReminders({ send: rec.send });
    expect(stats.sent).toBe(1);
    expect(stats.late).toBe(0);
    expect(rec.sent).toEqual([
      { chatId: CHAT_A, text: "Напоминание:\nпроверить сборку", agentKey: "orchestrator" },
    ]);
    const row = getReminder(r.id)!;
    expect(row.status).toBe("sent");
    expect(row.sent_at).not.toBeNull();
  });

  test("будущее не трогается", async () => {
    const now = Date.now();
    createReminder({ chatId: CHAT_A, agentKey: "pm", text: "потом", remindAt: now + HOUR, now });
    const rec = recorder();
    await deliverDueReminders({ send: rec.send });
    expect(rec.sent).toEqual([]);
  });

  test("повторный проход (в т.ч. после рестарта) не шлёт второй раз", async () => {
    seedDue(CHAT_A, "один раз", 30_000);
    const rec = recorder();

    // «Первый процесс»: планировщик, первый тик и остановка.
    const first = startReminderScheduler({ send: rec.send, intervalMs: 3_600_000 });
    await first.tickNow();
    first.stop();

    // «Рестарт»: новый планировщик на той же БД.
    const second = startReminderScheduler({ send: rec.send, intervalMs: 3_600_000 });
    await second.tickNow();
    await second.tickNow();
    second.stop();
    await deliverDueReminders({ send: rec.send });

    expect(rec.sent.length).toBe(1);
  });

  test("два параллельных прохода — одна отправка (атомарный захват)", async () => {
    seedDue(CHAT_A, "гонка", 30_000);
    const sent: number[] = [];
    const slowSend: ReminderSender = async (chatId) => {
      await new Promise((r) => setTimeout(r, 20));
      sent.push(chatId);
    };
    await Promise.all([
      deliverDueReminders({ send: slowSend }),
      deliverDueReminders({ send: slowSend }),
    ]);
    expect(sent).toEqual([CHAT_A]);
  });

  test("процесс умер посреди отправки: после рестарта не повторяем, а помечаем failed", async () => {
    const r = seedDue(CHAT_A, "может, ушло", 20 * MIN);
    // Имитация: захват случился, итог не записан, процесс упал.
    const claimedAt = Date.now() - SENDING_STALE_MS - MIN;
    db.prepare(
      "UPDATE reminders SET status='sending', claimed_at=?, attempts=1 WHERE id=?",
    ).run(claimedAt, r.id);

    const rec = recorder();
    const stats = await deliverDueReminders({ send: rec.send });
    expect(rec.sent).toEqual([]);
    expect(stats.stale).toBe(1);
    const row = getReminder(r.id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("interrupted");

    // И в списке оно видно, чтобы человек мог проверить сам.
    const listed = listReminders(CHAT_A);
    expect(listed.rows.map((x) => x.status)).toEqual(["failed"]);
  });

  test("свежий 'sending' (идёт прямо сейчас) не трогается", async () => {
    const r = seedDue(CHAT_A, "в пути", MIN);
    db.prepare("UPDATE reminders SET status='sending', claimed_at=?, attempts=1 WHERE id=?").run(
      Date.now(),
      r.id,
    );
    const rec = recorder();
    await deliverDueReminders({ send: rec.send });
    expect(rec.sent).toEqual([]);
    expect(getReminder(r.id)!.status).toBe("sending");
  });

  test("просроченное за простой уходит один раз и с пометкой об опоздании", async () => {
    const r = seedDue(CHAT_A, "проверить бэкап", 2 * HOUR);
    const rec = recorder();
    const stats = await deliverDueReminders({ send: rec.send });
    expect(stats.sent).toBe(1);
    expect(stats.late).toBe(1);
    expect(rec.sent.length).toBe(1);
    expect(rec.sent[0].chatId).toBe(CHAT_A);
    expect(rec.sent[0].text).toBe(
      `Напоминание (с опозданием: должно было прийти ${formatMsk(r.remind_at)} МСК):\nпроверить бэкап`,
    );
    await deliverDueReminders({ send: rec.send });
    expect(rec.sent.length).toBe(1);
  });

  test("ошибка отправки — повтор на следующем проходе, после MAX_ATTEMPTS — failed", async () => {
    const r = seedDue(CHAT_A, "нестабильная сеть", MIN);
    let calls = 0;
    const failing: ReminderSender = async () => {
      calls++;
      throw new Error("network down");
    };
    for (let k = 0; k < MAX_ATTEMPTS + 2; k++) {
      await deliverDueReminders({ send: failing });
    }
    expect(calls).toBe(MAX_ATTEMPTS);
    const row = getReminder(r.id)!;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(MAX_ATTEMPTS);
    expect(row.error).toContain("network down");
  });

  test("ошибка, затем успех — ровно одно доставленное сообщение", async () => {
    const r = seedDue(CHAT_A, "со второй попытки", MIN);
    const rec = recorder();
    let first = true;
    const flaky: ReminderSender = async (...args) => {
      if (first) {
        first = false;
        throw new Error("timeout");
      }
      return rec.send(...args);
    };
    const s1 = await deliverDueReminders({ send: flaky });
    expect(s1.retried).toBe(1);
    expect(getReminder(r.id)!.status).toBe("scheduled");
    await deliverDueReminders({ send: flaky });
    await deliverDueReminders({ send: flaky });
    expect(rec.sent.length).toBe(1);
    expect(getReminder(r.id)!.status).toBe("sent");
  });

  test("строка с адресатом-каналом (подложенная в обход создания) не отправляется", async () => {
    const r = seedDue(CHAT_A, "в канал нельзя", MIN);
    db.prepare("UPDATE reminders SET chat_id=? WHERE id=?").run(delabsChannelId(), r.id);
    const rec = recorder();
    const stats = await deliverDueReminders({ send: rec.send });
    expect(rec.sent).toEqual([]);
    expect(stats.failed).toBe(1);
    expect(getReminder(r.id)!.status).toBe("failed");
  });
});
