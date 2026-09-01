/**
 * Аудит 2026-08-28: список аудита читал тела, которых сам никогда не показывал.
 *
 * `listActions` брала `SELECT *`, то есть тянула из SQLite и парсила JSON'ом
 * `payload` и `result` каждой строки. Оба её потребителя эти поля выбрасывают
 * и делают это намеренно:
 *
 *   - `/audit` (commands.ts) печатает `[ts] agent action status` — четыре поля;
 *   - `GET_LOGS` (tools-schema.ts) собирает проекцию с комментарием
 *     «БЕЗ payload/result (там могла быть переписка)».
 *
 * Цена — не абстрактная: `SEND_DOCUMENT` пропускает до 2 МБ текста в
 * `payload.content` (build-payload.ts), `WRITE_WIKI` кладёт туда markdown
 * страницы целиком, а `/audit 100` берёт сто строк. То есть чтобы напечатать
 * сто коротких строк, процесс мог прочитать и распарсить сотни мегабайт —
 * и выбросить всё до единого байта.
 *
 * Второе: код, чья заявленная задача «контент не показывать», материализовывал
 * этот контент в памяти. Безопасно by-construction — это его не доставать.
 *
 * Одну строку с телами по-прежнему отдаёт `getAction(id)` — там это и нужно
 * (diagnostic-action читает payload упавшего действия). Инвариант после
 * правки: список — метаданные, точечное чтение — с телами.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { getAction, listActions, logAction } from "../lib/audit.ts";
import { cmdAudit } from "../lib/commands.ts";
import { db } from "../lib/db.ts";

const AGENT = "qa";
const CHAT = -560001;
const BIG = "ю".repeat(200_000);

const AUDIT_SRC = readFileSync(new URL("../lib/audit.ts", import.meta.url), "utf-8");
const BUILD_SRC = readFileSync(
  new URL("../lib/dispatch/build-payload.ts", import.meta.url),
  "utf-8",
);

function seed(): string {
  const { id } = logAction({
    agentKey: AGENT,
    chatId: CHAT,
    actionType: "SEND_DOCUMENT",
    payload: { content: BIG, filename: "big.md" },
    status: "ok",
    result: { ok: true, note: BIG },
    requestId: "req-proj-1",
  });
  return id;
}

function cleanup(): void {
  db.prepare(`DELETE FROM agent_actions WHERE chat_id = ?`).run(CHAT);
}

beforeEach(cleanup);
afterEach(cleanup);

describe("предпосылки", () => {
  test("в payload действительно попадают мегабайтные тела", () => {
    // Верхняя граница объявлена в самом валидаторе SEND_DOCUMENT.
    expect(BUILD_SRC).toContain("const MAX = 2_000_000;");
    const id = seed();
    const one = getAction(id)!;
    expect((one.payload as { content: string }).content.length).toBe(BIG.length);
  });

  test("оба потребителя списка тела не печатают", () => {
    const cmd = readFileSync(new URL("../lib/commands.ts", import.meta.url), "utf-8");
    const tools = readFileSync(new URL("../lib/tools-schema.ts", import.meta.url), "utf-8");
    expect(cmd).toContain("${a.agent_key} ${a.action_type} ${a.status}");
    expect(tools).toContain("error: a.error ?? undefined,");
  });
});

describe("список отдаёт метаданные, а не тела", () => {
  test("строк payload/result в выдаче нет вовсе", () => {
    seed();
    const rows = listActions({ agentKey: AGENT, chatId: CHAT });
    expect(rows.length).toBe(1);
    const row = rows[0] as Record<string, unknown>;
    expect("payload" in row).toBe(false);
    expect("result" in row).toBe(false);
  });

  test("метаданные на месте все до одного", () => {
    const id = seed();
    const row = listActions({ agentKey: AGENT, chatId: CHAT })[0];
    expect(row.id).toBe(id);
    expect(row.agent_key).toBe(AGENT);
    expect(row.chat_id).toBe(CHAT);
    expect(row.action_type).toBe("SEND_DOCUMENT");
    expect(row.status).toBe("ok");
    expect(row.error).toBe(null);
    expect(row.request_id).toBe("req-proj-1");
    expect(row.task_id).toBe(null);
    expect(row.tg_message_id).toBe(null);
    expect(typeof row.created_at).toBe("number");
  });

  test("точечное чтение по id тела по-прежнему отдаёт", () => {
    const id = seed();
    const one = getAction(id)!;
    expect((one.result as { note: string }).note.length).toBe(BIG.length);
  });
});

describe("фильтры и порядок не изменились", () => {
  test("фильтр по агенту, статусу и чату работает как раньше", () => {
    logAction({ agentKey: AGENT, chatId: CHAT, actionType: "SEND_MESSAGE", status: "error", error: "boom" });
    logAction({ agentKey: AGENT, chatId: CHAT, actionType: "SEND_MESSAGE", status: "ok" });
    expect(listActions({ agentKey: AGENT, chatId: CHAT }).length).toBe(2);
    expect(listActions({ agentKey: AGENT, chatId: CHAT, status: "error" }).length).toBe(1);
    expect(listActions({ agentKey: AGENT, chatId: -1 }).length).toBe(0);
    expect(listActions({ agentKey: "orchestrator", chatId: CHAT }).length).toBe(0);
  });

  test("порядок — свежие первыми, limit режет выдачу", () => {
    for (let i = 0; i < 3; i++) {
      logAction({ agentKey: AGENT, chatId: CHAT, actionType: "SEND_MESSAGE", status: "ok", error: `e${i}` });
    }
    const rows = listActions({ agentKey: AGENT, chatId: CHAT, limit: 2 });
    expect(rows.length).toBe(2);
    expect(rows[0].created_at).toBeGreaterThanOrEqual(rows[1].created_at);
  });
});

describe("выдача /audit не изменилась", () => {
  test("строка остаётся «[ts] agent action status»", () => {
    seed();
    const out = cmdAudit({ args: [AGENT] });
    const line = out.split("\n").find((l) => l.includes("SEND_DOCUMENT"))!;
    expect(line).toMatch(/^\[[^\]]+\] qa SEND_DOCUMENT ok$/);
    // Кусок тела в вывод не просачивался и раньше — фиксируем, что и теперь.
    expect(out).not.toContain("ю".repeat(20));
  });
});

describe("из БД тела не запрашиваются", () => {
  // Только код: строки ниже цитируются в комментарии, который объясняет,
  // что именно убрали (source-guard на собственном тексте иначе всегда красный).
  const CODE = AUDIT_SRC.split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  test("listActions перечисляет колонки, а не берёт SELECT *", () => {
    expect(CODE).toContain("SELECT ${SUMMARY_COLUMNS} FROM agent_actions");
    expect(CODE).not.toContain("`SELECT * FROM agent_actions`");
    expect(CODE).not.toContain("SELECT * FROM agent_actions` +");
  });

  test("в перечислении нет ни payload, ни result", () => {
    const cols = CODE.match(/const SUMMARY_COLUMNS =[\s\S]*?;/)![0];
    expect(cols).not.toContain("payload");
    expect(cols).not.toContain("result");
    for (const c of [
      "id",
      "agent_key",
      "task_id",
      "chat_id",
      "tg_message_id",
      "action_type",
      "status",
      "error",
      "created_at",
      "request_id",
    ]) {
      expect(cols).toContain(c);
    }
  });

  test("getAction тела по-прежнему берёт — иначе diagnostic-action ослепнет", () => {
    expect(CODE).toContain("SELECT * FROM agent_actions WHERE id = ?");
  });
});
