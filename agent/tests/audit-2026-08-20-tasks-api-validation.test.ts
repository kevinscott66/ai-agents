/**
 * Аудит 2026-08-20 — две дыры валидации на /api/tasks, обе отвечают «успех».
 *
 * 1. POST: chat_id проверялся одним `Number.isFinite(Number(raw))`. Это не
 *    проверка типа, а приведение: `[]` → 0, `true` → 1, `"0x10"` → 16,
 *    `1.9` остаётся 1.9. Ответ во всех случаях — 201 с телом созданной задачи,
 *    а сама задача не появится НИ В ОДНОМ списке: listTasksByChat ищет точное
 *    равенство. Соседний POST /api/autonomy уже делал это правильно.
 *
 * 2. GET: незнакомый ?status= молча ронял фильтр, и вместо «задач в статусе X»
 *    приходила вся доска — с ответом 200, по которому отличить одно от
 *    другого невозможно. Тот же класс уже чинили для before_id в /api/actions.
 *
 * Инвариант: запрос, который нельзя выполнить как написано, получает 4xx, а не
 * успех с другим смыслом.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_tasks_validation";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { strictChatId } from "../lib/http-utils.ts";
import { listTasksByChat, updateTaskStatus } from "../lib/tasks.ts";
import { TASK_STATUSES } from "../lib/types.ts";

const BOT_TOKEN = "test_bot_token_tasks_validation";
const USER_ID = 820001;
const CHAT_ID = -1008200001;

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "q-tasks-validation",
    user: JSON.stringify({
      id: USER_ID,
      username: "tasksvalidation",
      first_name: "Tasks",
      is_bot: false,
    }),
  });
}

let server: MiniappServerHandle;
let baseUrl: string;

beforeAll(async () => {
  server = await startMiniappServer({
    adminUserIds: [USER_ID],
    allowedUserIds: [USER_ID],
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(async () => {
  await server.stop();
});

async function createTaskReq(body: unknown) {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Init-Data": freshInitData(),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/tasks — chat_id это целое число, а не всё приводимое", () => {
  // Каждое из значений раньше давало 201 и задачу в чате, которого не
  // называли. Приведение указано в комментарии — оно и есть суть дефекта.
  const cases: Array<[string, unknown]> = [
    ["пустой массив (Number([]) === 0)", []],
    ["true (Number(true) === 1)", true],
    ['строка "0x10" (Number → 16)', "0x10"],
    ["дробное 1.9", 1.9],
    ["объект", { id: 1 }],
    ['строка с пробелом " -100 "', " -100 "],
    ["за пределами безопасных целых", 9007199254740993],
  ];

  for (const [name, value] of cases) {
    test(`отказ: ${name}`, async () => {
      const r = await createTaskReq({ title: "Задача", chat_id: value });
      expect(r.status).toBe(400);
      expect(String(r.body.error)).toContain("chat_id");
    });
  }

  test("нормальный chat_id по-прежнему создаёт задачу, и она видна в чате", async () => {
    const r = await createTaskReq({ title: "Настоящая задача", chat_id: CHAT_ID });
    expect(r.status).toBe(201);
    const found = listTasksByChat(CHAT_ID, undefined, 50);
    expect(found.some((t) => t.title === "Настоящая задача")).toBe(true);
  });

  test("chat_id строкой — тоже принимается (клиент шлёт String(chat_id))", async () => {
    const r = await createTaskReq({
      title: "Задача строкой",
      chat_id: String(CHAT_ID),
    });
    expect(r.status).toBe(201);
    expect(
      listTasksByChat(CHAT_ID, undefined, 50).some(
        (t) => t.title === "Задача строкой",
      ),
    ).toBe(true);
  });
});

describe("GET /api/tasks — незнакомый статус это ошибка, а не «без фильтра»", () => {
  async function listReq(qs: string) {
    const res = await fetch(`${baseUrl}/api/tasks${qs}`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  test("?status=BOGUS → 400, а не вся доска", async () => {
    const r = await listReq("?status=BOGUS");
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("status");
  });

  test("опечатка в регистре тоже ловится (?status=Pending)", async () => {
    // Список статусов регистрозависимый — TASK_STATUSES.includes сравнивает
    // строки. Раньше это давало полную доску под видом фильтра.
    expect((await listReq("?status=Pending")).status).toBe(400);
  });

  test("известный статус фильтрует — даже без chat_id и assignee", async () => {
    // Третий дефект того же обработчика, найденный этим самым тестом: ветка
    // «нет ни chat_id, ни assignee» шла прямым сканом и `statuses` не
    // применяла вовсе. То есть ?status=pending без chat_id работал как запрос
    // без фильтра, отвечая 200. `load()` в Dashboard.tsx зовёт ровно так —
    // `api.tasks({ status: "pending", limit: 200 })`, — и список «в очереди»
    // на главной показывал задачи в любом статусе, включая done и cancelled.
    //
    // В одиночном прогоне файла тест был зелёным и на сломанном коде: в свежей
    // тестовой БД все задачи и так pending. Красным он становится только на
    // полном прогоне, где соседние файлы наполняют доску. Поэтому здесь
    // задача в НЕ-pending статусе создаётся явно.
    const created = await createTaskReq({
      title: "Задача, которую нужно отфильтровать",
      chat_id: CHAT_ID,
    });
    expect(created.status).toBe(201);
    const task = created.body.task as { id: string };
    updateTaskStatus(task.id, "cancelled");

    const r = await listReq("?status=pending&limit=200");
    expect(r.status).toBe(200);
    const tasks = r.body.tasks as Array<{ id: string; status: string }>;
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.every((t) => t.status === "pending")).toBe(true);
    expect(tasks.some((t) => t.id === task.id)).toBe(false);
  });

  test("ответ 400 перечисляет допустимые статусы", async () => {
    // Иначе клиент видит «неверно», но не видит чем: `in-progress` пишут как
    // `in_progress`, и без перечня в теле опечатку чинят чтением исходника.
    const r = await listReq("?status=in_progress");
    expect(r.status).toBe(400);
    expect(r.body.allowed).toEqual([...TASK_STATUSES]);
  });

  test("пустой `status=` — тоже 400: фильтр запрошен, но не назван", async () => {
    // Проверка идёт по `status !== null`, а не по truthiness: пустая строка —
    // это заданный, но неназванный фильтр. Как falsy она раньше читалась как
    // «фильтра нет» и возвращала всю доску. Фронт пустой параметр не ставит
    // (miniapp/src/lib/api.ts), так что прийти он может только из ручного
    // запроса или бага клиента — и то и другое лучше видеть.
    expect((await listReq("?status=")).status).toBe(400);
  });

  test("каждый канонический статус принимается", async () => {
    // Страховка от «починили валидацию, но списком с опечаткой»: 400 на
    // легальный статус — регрессия ровно того же рода, что и тихая выдача.
    for (const st of TASK_STATUSES) {
      expect((await listReq(`?status=${st}`)).status).toBe(200);
    }
  });

  test("без status фильтра нет — это по-прежнему валидный запрос", async () => {
    expect((await listReq("?limit=5")).status).toBe(200);
  });
});

describe("strictChatId — общий предикат", () => {
  test("принимает целые числа и целочисленные строки", () => {
    expect(strictChatId(-1001234567890)).toBe(-1001234567890);
    expect(strictChatId("-1001234567890")).toBe(-1001234567890);
    expect(strictChatId(0)).toBe(0);
    expect(strictChatId("0")).toBe(0);
  });

  test("отвергает всё, что раньше проскакивало через Number()", () => {
    for (const v of [[], true, false, "0x10", 1.9, "1.9", {}, null, undefined, "", " 5 ", "1e3", NaN, Infinity]) {
      expect(strictChatId(v)).toBeNull();
    }
  });

  test("канонизирует строку: scope_key ищется по String(chatId)", () => {
    // "007" писалось в scope_key как есть, а читатель ищет "7" — правило
    // записывалось в никуда. Отдельная ветка того же дефекта.
    expect(strictChatId("007")).toBe(7);
  });
});
