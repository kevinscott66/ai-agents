/**
 * В форме создания задачи стоял селектор «Тип» (general/feature/bug/research),
 * который не делал ничего.
 *
 * Сервер кладёт тип в `tasks.input` — и только если поля «Ввод» нет вовсе
 * (ветка `POST /api/tasks` в lib/miniapp-server.ts, поле `inputPayload`
 * у вызова `createTask`):
 *
 *   inputPayload: body.input !== undefined ? body.input
 *               : body.type ? { type: body.type } : undefined
 *
 * Клиент же слал `type` всегда. Отсюда два исхода, и оба плохие:
 *   • «Ввод» заполнен → выбранный тип молча выбрасывается;
 *   • «Ввод» пуст → в `input` ложится `{"type":"general"}`, которое не читает
 *     никто. `input` — не свалка меток: по нему живут self-diag
 *     (`input.type === "diagnostic"`, lib/diagnostic.ts:21) и учёт делегаций
 *     (`_delegation_*`, lib/tasks.ts), и он же режется редактором контента
 *     не-админам (TASK_CONTENT_FIELDS в lib/miniapp-server.ts).
 *
 * Ни одного потребителя у general/feature/bug/research в репозитории нет:
 * сама константа приехала бутстрапом шаблона (7b2abea4) и осталась не
 * подключённой. Селектор убран; ниже — тесты, которые не дадут вернуть его,
 * не подключив, и фиксация серверного правила для того, кто соберётся.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

const BOT_TOKEN = "test_bot_token_for_task_type";
const ADMIN_ID = 900_811;
const CHAT_ID = -100_900_811;

let server: MiniappServerHandle;
let base: string;

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      "X-Telegram-Init-Data": buildInitData(BOT_TOKEN, {
        auth_date: String(Math.floor(Date.now() / 1000)),
        query_id: `q-${ADMIN_ID}`,
        user: JSON.stringify({ id: ADMIN_ID, first_name: "U" }),
      }),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
}

async function create(body: Record<string, unknown>) {
  const r = await call("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ title: "t", chat_id: CHAT_ID, ...body }),
  });
  expect(r.status).toBe(201);
  return (await r.json()).task as { id: string; input: unknown };
}

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [ADMIN_ID],
    adminUserIds: [ADMIN_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
});

describe("серверное правило: type проигрывает input", () => {
  test("есть input — type выброшен без следа", async () => {
    const t = await create({ input: { foo: 1 }, type: "bug" });
    expect(t.input).toEqual({ foo: 1 });
  });

  test("строковый input тоже вытесняет type", async () => {
    const t = await create({ input: "почини сборку", type: "bug" });
    expect(t.input).toBe("почини сборку");
  });

  test("без input тип оседает в input отдельным объектом", async () => {
    // Именно эта ветка и засоряла `input`: метка, которую никто не читает,
    // занимала поле, по которому работает self-diag и учёт делегаций.
    const t = await create({ type: "bug" });
    expect(t.input).toEqual({ type: "bug" });
  });

  test("без type и без input поле остаётся пустым", async () => {
    const t = await create({});
    expect(t.input).toBe(null);
  });
});

describe("форма создания задачи", () => {
  const RAW = readFileSync(
    new URL("../miniapp/src/pages/Tasks.tsx", import.meta.url),
    "utf8",
  );
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("мёртвого селектора нет", () => {
    expect(SRC).not.toContain("TASK_TYPES");
    expect(SRC).not.toContain("nType");
  });

  test("тип не уходит на сервер", () => {
    expect(SRC).not.toMatch(/\btype:\s*n?[Tt]ype\b/);
  });

  test("остальные поля формы на месте", () => {
    // Удаление не должно было задеть соседей по форме.
    expect(SRC).toContain("title: nTitle.trim()");
    expect(SRC).toContain("chat_id: chatNum");
    expect(SRC).toContain("assignee: nAssignee || undefined");
    expect(SRC).toContain("input: parsedInput");
  });
});
