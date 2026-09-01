/**
 * Аудит 2026-08-27: две команды отвечали не на тот вопрос, который им задали.
 *
 * 1. `/approvals <role>`. `cmdApprovals` принимала `args: string[]` и не
 *    читала их ни разу — печаталась ВСЯ очередь чата под запросом об одной
 *    роли. Тот же класс, что чинили в `/tasks` часом раньше: молчаливое
 *    расширение выборки хуже отказа, по нему делают вывод «у smm двадцать
 *    заявок» и идут решать чужие.
 *
 * 2. `/autonomy locked`. Приписка утверждала «у этих ролей свой режим, он
 *    сильнее чатового» безусловно. С аудита 2026-08-20 это неправда для
 *    `locked`: стоп-кран чата читается в `getAutonomy` ПЕРВЫМ и строку роли
 *    перекрывает. Владелец жал стоп-кран посреди инцидента и читал в ответ,
 *    что роль продолжает работать в `auto`, — ошибка ровно в опасную сторону.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { cmdApprovals, cmdAutonomy } from "../lib/commands.ts";
import { createApproval } from "../lib/approvals.ts";
import { setAutonomy, getAutonomy, clearAutonomy } from "../lib/permissions.ts";

const CHAT = -1_000_827;
const OTHER_CHAT = -1_000_828;

function clean() {
  db.prepare("DELETE FROM approvals WHERE chat_id IN (?, ?)").run(
    CHAT,
    OTHER_CHAT,
  );
}

function seed(requestedBy: string, chatId = CHAT) {
  createApproval({
    actionId: crypto.randomUUID(),
    chatId,
    requestedBy,
    actionType: "SEND_MESSAGE",
    payload: { text: `от ${requestedBy}` },
  });
}

describe("/approvals уважает роль в аргументе", () => {
  beforeEach(clean);
  afterEach(clean);

  test("без аргумента — вся очередь чата, как и было", () => {
    seed("smm");
    seed("qa");
    const out = cmdApprovals({ chatId: CHAT, args: [] });
    expect(out).toContain("smm");
    expect(out).toContain("qa");
  });

  test("с ролью — только её заявки", () => {
    seed("smm");
    seed("qa");
    seed("qa");
    const out = cmdApprovals({ chatId: CHAT, args: ["qa"] });
    expect(out).not.toContain("smm");
    expect(out.split("\n").filter((l) => l.includes("qa")).length).toBe(2);
  });

  test("у роли пусто — так и сказано, а не вся очередь чата", () => {
    seed("smm");
    const out = cmdApprovals({ chatId: CHAT, args: ["qa"] });
    expect(out).toBe("нет ожидающих approvals от qa");
  });

  test("неизвестная роль — отказ со списком, а не тихая выдача всего", () => {
    seed("smm");
    const out = cmdApprovals({ chatId: CHAT, args: ["designer"] });
    expect(out).toContain("Неизвестный agent: designer");
    expect(out).not.toContain("SEND_MESSAGE");
  });

  test("хвост «и ещё N» считает ту же очередь, что показал", () => {
    // 25 заявок роли + 5 чужих: без фильтра в счётчике хвост показал бы 10.
    for (let i = 0; i < 25; i++) seed("qa");
    for (let i = 0; i < 5; i++) seed("smm");
    const out = cmdApprovals({ chatId: CHAT, args: ["qa"] });
    expect(out).toContain("и ещё 5");
    expect(out).not.toContain("smm");
  });

  test("фильтр по роли не пробивает границу чата", () => {
    seed("qa", OTHER_CHAT);
    const out = cmdApprovals({ chatId: CHAT, args: ["qa"] });
    expect(out).toBe("нет ожидающих approvals от qa");
  });
});

describe("/autonomy не врёт про стоп-кран", () => {
  const LOCKED_CHAT = -1_000_829;
  const OPEN_CHAT = -1_000_830;

  beforeEach(() => {
    setAutonomy("agent", "design", "auto");
  });
  afterEach(() => {
    clearAutonomy("agent", "design");
  });

  test("locked: роль названа перекрытой, а не «не затронутой»", () => {
    const out = cmdAutonomy({ chatId: LOCKED_CHAT, mode: "locked" });
    // Контроль: гейт для этой роли действительно вернёт locked.
    expect(getAutonomy(LOCKED_CHAT, "design")).toBe("locked");
    expect(out).toContain("Стоп-кран чата перекрывает");
    expect(out).toContain("design=auto→locked");
    expect(out).not.toContain("Не затронуты");
  });

  test("не-locked: роль по-прежнему названа не затронутой", () => {
    const out = cmdAutonomy({ chatId: OPEN_CHAT, mode: "semi_auto" });
    expect(getAutonomy(OPEN_CHAT, "design")).toBe("auto");
    expect(out).toContain("Не затронуты");
    expect(out).toContain("design=auto");
    expect(out).not.toContain("Стоп-кран");
  });

  test("роль со своим locked в остановленном чате не числится перекрытой", () => {
    setAutonomy("agent", "smm", "locked");
    try {
      const out = cmdAutonomy({ chatId: LOCKED_CHAT, mode: "locked" });
      // Её собственный режим совпадает с эффективным — врать не о чем.
      expect(out).toContain("smm=locked");
      expect(out).not.toContain("smm=locked→");
    } finally {
      clearAutonomy("agent", "smm");
    }
  });

  test("чтение режима показывает ту же картину, что установка", () => {
    cmdAutonomy({ chatId: LOCKED_CHAT, mode: "locked" });
    const out = cmdAutonomy({ chatId: LOCKED_CHAT });
    expect(out).toContain("Стоп-кран чата перекрывает");
    expect(out).toContain("design=auto→locked");
  });
});
