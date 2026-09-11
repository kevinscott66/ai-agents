/**
 * Аудит 2026-09-11, круг 51: `tasks` — второй сток секретов, и течёт он туда
 * же, куда тек первый.
 *
 * Тем же кругом скраб поставили на границу записи в `agent_actions`
 * (`lib/audit.ts`). Дыра там была не в вызывающих, а в том, что чистить
 * приходилось каждому по отдельности — то есть только известным. В `tasks`
 * было ровно то же самое, и наружу она смотрит не меньше: доску отдаёт Mini
 * App (`/api/tasks`), список читает сама модель через LIST_TASKS.
 *
 * Два живых источника недоверенного текста:
 *   • `action-dispatch.ts` при падении действия копирует `res.error` СРАЗУ В
 *     ДВА поля — `description` и `input.error`. Текст туда приходит от
 *     упавшего HTTP-вызова: URL с токеном в пути, тело ответа, заголовок;
 *   • `failRoleTask` (`role-runtime.ts`) кладёт в `error` текст исключения
 *     прогона роли — то же самое, только этажом выше.
 *
 * ГРАНИЦА НАМЕРЕННО НЕ СПЛОШНАЯ. Санитары (`gc_stale` в db-maint.ts, «lease
 * expired» в role-runtime.ts, пять сообщений self-diag.ts) пишут в ту же
 * колонку константы, собранные из литералов на месте. Гонять их через скраб
 * нечего, и требовать этого сторожем значило бы завести правило ради правила.
 * Ниже проверяется поведение трёх настоящих путей и один текстовый инвариант:
 * что определение «что кладётся в tasks.error» осталось ровно одно.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createTask,
  failTask,
  getTask,
  taskErrorValue,
  TASK_ERROR_MAX,
} from "../lib/tasks.ts";
import { db } from "../lib/db.ts";

const BOT_TOKEN = "7123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";
const LEAK = `POST https://api.telegram.org/bot${BOT_TOKEN}/sendMessage -> 400`;

function rawRow(id: string): { description: string | null; input: string | null; error: string | null } {
  return db
    .prepare("SELECT description, input, error FROM tasks WHERE id=?")
    .get(id) as { description: string | null; input: string | null; error: string | null };
}

describe("секрет не доезжает до колонок tasks", () => {
  test("createTask чистит description и input — оба поля пути self-diag", () => {
    // Ровно тот вызов, который делает action-dispatch при падении действия:
    // одна и та же строка уходит в два поля.
    const t = createTask({
      chatId: 424242,
      createdBy: "orchestrator",
      title: "Tool error: SEND_MESSAGE",
      description: LEAK,
      inputPayload: { actionType: "SEND_MESSAGE", error: LEAK, _diag: true },
    });
    const row = rawRow(t.id);
    expect(row.description).not.toContain(BOT_TOKEN);
    expect(row.input).not.toContain(BOT_TOKEN);
    expect(row.description).toContain("***");
    expect(row.input).toContain("***");
    // Диагностика цела: видно и тип ключа, и куда шёл запрос.
    expect(row.description).toContain("api.telegram.org");
    expect(row.description).toContain("7123456789:");
  });

  test("failTask чистит error", () => {
    const t = createTask({
      chatId: 424242,
      createdBy: "orchestrator",
      title: "чистый заголовок",
    });
    failTask(t.id, LEAK);
    const row = rawRow(t.id);
    expect(row.error).not.toContain(BOT_TOKEN);
    expect(row.error).toContain("***");
    expect(getTask(t.id)?.status).toBe("failed");
  });

  test("title не чистится — и не должен: свободного текста в нём нет", () => {
    // Оговорка в докблоке `taskErrorValue` проверяется, а не только пишется:
    // заголовок собирает код из имени действия. Если однажды туда станут
    // класть свободный текст, границу придётся расширять — и этот тест
    // напомнит, что решение было осознанным.
    const t = createTask({
      chatId: 424242,
      createdBy: "orchestrator",
      title: `Tool error: ${BOT_TOKEN}`,
    });
    expect(
      (db.prepare("SELECT title FROM tasks WHERE id=?").get(t.id) as { title: string }).title,
    ).toContain(BOT_TOKEN);
  });

  test("скраб идёт ДО обрезки, а не после", () => {
    // Каверза, ради которой порядок зафиксирован: обрезанный секрет перестаёт
    // совпадать с правилом, и в базу уезжает его начало нетронутым.
    const tail = `tail ${BOT_TOKEN}`;
    const out = taskErrorValue("x".repeat(TASK_ERROR_MAX - tail.length + 10) + tail);
    expect(out).not.toContain("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw");
    expect(out.length).toBeLessThanOrEqual(TASK_ERROR_MAX);
  });
});

describe("определение «что кладётся в tasks.error» ровно одно", () => {
  const ROLE_RUNTIME = readFileSync(
    join(import.meta.dir, "..", "lib", "role-runtime.ts"),
    "utf8",
  );

  test("failRoleTask идёт через помощник, а не режет сам", () => {
    // До круга 51 здесь стоял голый `error.slice(0, 4000)` — вторая копия
    // правила, разошедшаяся с первой в том, что скраба у неё не было вовсе.
    expect(ROLE_RUNTIME).toContain("taskErrorValue(error)");
    expect(ROLE_RUNTIME).not.toContain("error.slice(0, 4000)");
  });

  test("число 4000 живёт в одном месте", () => {
    expect(TASK_ERROR_MAX).toBe(4000);
    // Правило круга 20 в его положительной форме: константа вместо литерала,
    // рассыпанного по файлам.
    expect(ROLE_RUNTIME).not.toContain("4000");
  });
});
