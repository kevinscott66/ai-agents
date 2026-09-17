/**
 * Аудит 2026-09-11: `insertActionRow` молча превращал бы непарсящийся chat_id
 * в NULL.
 *
 * Тип `LogActionInput.chatId` допускал строку, и она приводилась через
 * `Number(...)` без проверки. `Number("abc")` — NaN; драйвер bun:sqlite кладёт
 * NaN в колонку как NULL. Результат был бы не «мусор в базе», а «строка аудита
 * без чата» — невидимая для чат-скоупных фильтров (`chat_id = ?` в
 * `listActions` и в /api/actions), то есть запись о действии есть, но её не
 * видно там, где её ищут.
 *
 * Реального вызывающего со строкой не было ни одного: все точки идут от
 * `DispatchCtx.chatId: number` либо от `user.id`, проверенного
 * `Number.isSafeInteger` в miniapp-auth. Поэтому починка — не проверка, а
 * сужение типа: строка сюда больше не представима. Что ветка была мёртвой,
 * доказал сам `tsc` — сужение не потребовало правок ни на одной стороне.
 *
 * ЧЕГО СТОРОЖ НЕ ДЕЛАЕТ. Он не проверяет источники chat_id и не заменяет
 * `strictChatId` (lib/http-utils.ts) — недоверенный ввод разбирают ДО аудита.
 * Он следит ровно за тем, чтобы приведение не вернулось в insertActionRow.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { insertActionRow } from "../lib/audit.ts";
import { db } from "../lib/db.ts";

const SRC = readFileSync(join(import.meta.dir, "..", "lib", "audit.ts"), "utf8");

/**
 * Тот же файл без комментариев: искать мёртвое приведение надо в КОДЕ.
 * Надгробие над `const chatId` обязано называть убранное выражение — иначе
 * следующий читатель не поймёт, чего именно здесь больше нет, — и сторож,
 * ловящий его в комментарии, запрещал бы ровно то объяснение, ради которого
 * стоит. Раздевание грубое (строковых литералов со слэшами в audit.ts нет), и
 * годится оно только для этих негативных проверок.
 */
function code(): string {
  return SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("chat_id аудита не приводится из строки", () => {
  test("тип не допускает строку", () => {
    expect(SRC).toContain("chatId?: number | null;");
    expect(SRC).not.toContain("chatId?: number | string | null;");
  });

  test("приведения из строки в коде нет", () => {
    const src = code();
    expect(src).not.toContain("Number(input.chatId)");
    expect(src).not.toMatch(/typeof input\.chatId === "string"/);
    // Предпосылка: раздевание не съело сам разбор chatId.
    expect(src).toContain("const chatId = input.chatId ?? null;");
  });

  test("число по-прежнему доезжает до колонки как число", () => {
    const chatId = -100_999_314_912;
    const row = insertActionRow("COMMENT_TASK", {
      agentKey: "audit-chatid-probe",
      chatId,
      status: "ok",
    });
    try {
      const got = db
        .prepare(`SELECT chat_id, typeof(chat_id) AS t FROM agent_actions WHERE id = ?`)
        .get(row.id) as { chat_id: number; t: string };
      expect(got.chat_id).toBe(chatId);
      expect(got.t).toBe("integer");
    } finally {
      db.prepare(`DELETE FROM agent_actions WHERE id = ?`).run(row.id);
    }
  });

  test("отсутствие чата по-прежнему даёт NULL, а не ноль", () => {
    const row = insertActionRow("COMMENT_TASK", {
      agentKey: "audit-chatid-probe",
      status: "ok",
    });
    try {
      const got = db
        .prepare(`SELECT typeof(chat_id) AS t FROM agent_actions WHERE id = ?`)
        .get(row.id) as { t: string };
      expect(got.t).toBe("null");
    } finally {
      db.prepare(`DELETE FROM agent_actions WHERE id = ?`).run(row.id);
    }
  });
});
