/**
 * Аудит 2026-08-09: два расхождения на путях отказа approval'а.
 *
 * (1) chat_id журнала. Telegram-путь штамповал чат, В КОТОРОМ набрали команду,
 *     Mini App — чат самого approval'а. Единственный читатель
 *     (/api/audit-logs) фильтрует по chat_id, так что отказ, сделанный админом
 *     в личке, пропадал из журнала командного чата — ровно там, где его будут
 *     искать. Существующий reject-audit-trail.test.ts передаёт одну и ту же
 *     константу в оба поля и расхождения увидеть не может.
 *
 * (2) Личность решающего. `deciderIdentity` возвращал
 *     `username ?? first_name ?? tg:<id>`: первым выбором шло то, что человек
 *     назначает себе сам, вторым — вообще не уникальное имя. Авторизация
 *     двумя строками выше делается правильно, по telegram id. Спрашивали у
 *     одной личности, записывали другую.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import { createApproval } from "../lib/approvals.ts";
import { cmdReject } from "../lib/commands.ts";
import { ADMIN_COMMANDS } from "../lib/admin-commands.ts";
import { readFileSync } from "node:fs";

const APPROVAL_CHAT = -1_000_811;
const DM_CHAT = 5_550_001;

const promptPayload = {
  target_agent_key: "smm",
  new_prompt: "x".repeat(60),
  reason: "хотим другой тон в канале",
};

function auditRows(chatId: number) {
  return db
    .prepare(
      `SELECT chat_id, payload FROM audit_logs
       WHERE event_type = 'UPDATE_AGENT_PROMPT_REJECTED' AND chat_id = ?`,
    )
    .all(chatId) as { chat_id: number; payload: string }[];
}

function cleanup() {
  for (const c of [APPROVAL_CHAT, DM_CHAT]) {
    db.prepare(`DELETE FROM audit_logs WHERE chat_id = ?`).run(c);
    db.prepare(`DELETE FROM approvals WHERE chat_id = ?`).run(c);
  }
}

beforeEach(cleanup);
afterEach(cleanup);

function pendingPromptApproval(chatId: number) {
  return createApproval({
    actionId: crypto.randomUUID(),
    actionType: "UPDATE_AGENT_PROMPT",
    payload: promptPayload,
    requestedBy: "perm",
    chatId,
  });
}

describe("журнал отказа лежит в чате approval'а", () => {
  test("отказ из лички попадает в журнал командного чата, а не лички", () => {
    const a = pendingPromptApproval(APPROVAL_CHAT);
    // Админ открыл личку с ботом и отклонил оттуда — обычный сценарий.
    const out = cmdReject({
      approvalId: a.id,
      decidedBy: "tg:777",
      chatId: DM_CHAT,
      reason: "не сейчас",
    });
    expect(out).toContain("Rejected");

    expect(auditRows(APPROVAL_CHAT).length).toBe(1);
    // До фикса строка уезжала сюда и в журнале командного чата её не было.
    expect(auditRows(DM_CHAT).length).toBe(0);
  });

  test("отказ в том же чате работает как раньше", () => {
    const a = pendingPromptApproval(APPROVAL_CHAT);
    cmdReject({
      approvalId: a.id,
      decidedBy: "tg:777",
      chatId: APPROVAL_CHAT,
      reason: "нет",
    });
    expect(auditRows(APPROVAL_CHAT).length).toBe(1);
  });

  test("Mini App-путь пишет туда же — оба пути согласованы", () => {
    // Mini App зовёт ту же auditRejectedApproval с a.chat_id; проверяем, что
    // Telegram-путь теперь даёт тот же chat_id при тех же входных данных.
    const a = pendingPromptApproval(APPROVAL_CHAT);
    cmdReject({
      approvalId: a.id,
      decidedBy: "tg:777",
      chatId: DM_CHAT,
    });
    const rows = auditRows(APPROVAL_CHAT);
    expect(rows.length).toBe(1);
    expect(rows[0]!.chat_id).toBe(APPROVAL_CHAT);
  });
});

describe("личность решающего — telegram id, а не отображаемое имя", () => {
  // deciderIdentity не экспортируется (внутренняя деталь регистрации команд),
  // поэтому проверяем её через ту же дверь, что и прод: сборку ctx в
  // registerAdminCommands. Форма зафиксирована по исходнику — тот же приём,
  // что и в других тестах на непримонтируемые handler'ы.
  const SRC = readFileSync(
    new URL("../lib/admin-commands.ts", import.meta.url),
    "utf8",
  );

  test("id обязателен и идёт первым", () => {
    const fn = SRC.slice(
      SRC.indexOf("function deciderIdentity"),
      SRC.indexOf("export function registerAdminCommands"),
    );
    expect(fn).toContain("ctx.from?.id");
    expect(fn).toContain("`tg:${id}`");
    // Ключевое: username не может быть значением сам по себе — только
    // припиской к id.
    expect(fn).not.toMatch(/return\s+ctx\.from\?\.username/);
    const idPos = fn.indexOf("const id = ctx.from?.id");
    const namePos = fn.indexOf("username");
    expect(idPos).toBeGreaterThan(-1);
    expect(idPos).toBeLessThan(namePos);
  });

  test("decidedBy передаётся в handler'ы approve и reject", () => {
    const names = ADMIN_COMMANDS.map((c) => c.name);
    expect(names).toContain("approve");
    expect(names).toContain("reject");
    const wiring = SRC.slice(SRC.indexOf("const reply = await c.handler"));
    expect(wiring).toContain("decidedBy: deciderIdentity(telegrafCtx)");
  });

  test("авторизация и запись смотрят на одно и то же поле", () => {
    // isAuthorizedAdmin сверяет ctx.from.id со списком; личность в журнале
    // теперь построена на нём же. Раньше первое было id, второе — username.
    const auth = SRC.slice(
      SRC.indexOf("export function isAuthorizedAdmin"),
      SRC.indexOf("export interface AdminCmdCtx"),
    );
    expect(auth).toContain("ctx.from?.id");
    expect(auth).not.toContain("username");
  });
});
