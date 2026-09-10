/**
 * Аудит 2026-09-10: три читающих ручки Mini App принимали заведомо негодный
 * параметр и отвечали 200.
 *
 * Общий класс — «фильтр молча не применился». Записывающие ветки того же файла
 * этот класс закрывали по одной (`badAgentKey`, аудит 2026-08-28: «опечатка
 * возвращала 200 с эхом „право применено", а evaluateGate строки 'Backend' не
 * видел никогда»), а читающие остались:
 *
 *  1. `GET /api/autonomy` — ключ роли не сверялся с CHARACTERS. `getAutonomy`
 *     по неизвестному ключу спускается на чатовый и глобальный уровень, и
 *     `?agent=Backend` отдавал ЧУЖОЙ режим рядом с эхом опечатки. Админ читает
 *     «Backend: semi_auto», а у роли `backend` стоит другое.
 *  2. `GET /api/actions?status=…` — `status` закрытое множество
 *     (ACTION_STATUSES), но неизвестное значение уходило в WHERE как есть:
 *     `200 {"actions":[]}`. Тот же тул через `tools-schema.ts` на это отвечает
 *     списком допустимых — там этот класс уже чинили («модель по здравому
 *     смыслу пишет `failed` — и получает count: 0, из которого докладывает
 *     „ошибок нет"»).
 *  3. `GET /api/audit-logs?before=…` — нечисловой курсор условие пагинации не
 *     добавлял, и вместе с ним пропадал `beforeId`. Клиент дописывает ответ к
 *     списку и снова берёт курсором последний показанный элемент — дубликаты и
 *     «Загрузить ещё», которая не кончается.
 *
 * Здесь же закреплены две ГРАНИЦЫ, чтобы следующий проход не «дочинил» лишнее:
 * `type` (`action_type`) и `agent` (`agent_key`) словарями не проверяются
 * намеренно — колонка `action_type` открытая (`logToolCall` пишет туда имя
 * любой тулзы), а `agent_key` бывает составным (`design:svg-fallback`).
 */
process.env.MINIAPP_BOT_TOKEN = "miniapp-filter-validation-token";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import { startMiniappServer, type MiniappServerHandle } from "../lib/miniapp-server.ts";
import { ACTION_STATUSES } from "../lib/audit.ts";

const BOT_TOKEN = "miniapp-filter-validation-token";
const ADMIN_ID = 74301;
// Bun 1.3.14 в этой мастерской не умеет биндить эфемерный порт 0 — берём
// свободный фиксированный, как в соседних HTTP-тестах.
const TEST_PORT = Number(process.env.MINIAPP_FILTER_TEST_PORT ?? "28911");

function initData(userId: number): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: `filter-${userId}`,
    user: JSON.stringify({ id: userId, username: "filter", first_name: "F" }),
  });
}

let server: MiniappServerHandle;

async function get(pathAndQuery: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${pathAndQuery}`, {
    headers: { "X-Telegram-Init-Data": initData(ADMIN_ID) },
  });
  let body: any = null;
  try {
    body = await response.json();
  } catch {
    // Тело может быть пустым — тесту хватит статуса.
  }
  return { status: response.status, body };
}

beforeAll(() => {
  server = startMiniappServer({
    port: TEST_PORT,
    botToken: BOT_TOKEN,
    allowedUserIds: [ADMIN_ID],
    adminUserIds: [ADMIN_ID],
  });
});

afterAll(() => server.stop());

describe("GET /api/autonomy — ключ роли", () => {
  test("неизвестный ключ — 400, а не чужой режим", async () => {
    const r = await get("/api/autonomy?agent=Backend");
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("unknown agentKey");
  });

  test("канонический ключ проходит", async () => {
    const r = await get("/api/autonomy?agent=backend");
    expect(r.status).toBe(200);
    expect(typeof r.body?.mode).toBe("string");
  });

  test("без параметра — по-прежнему 200", async () => {
    const r = await get("/api/autonomy");
    expect(r.status).toBe(200);
  });

  test("пустой `agent=` — это «без роли», не опечатка", async () => {
    const r = await get("/api/autonomy?agent=");
    expect(r.status).toBe(200);
  });
});

describe("GET /api/actions — словарь статусов", () => {
  test("неизвестный статус — 400 со списком допустимых", async () => {
    const r = await get("/api/actions?status=failed");
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("failed");
    expect(r.body?.allowed).toEqual([...ACTION_STATUSES]);
  });

  test("каждый статус из ACTION_STATUSES принимается", async () => {
    for (const status of ACTION_STATUSES) {
      const r = await get(`/api/actions?status=${encodeURIComponent(status)}`);
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body?.actions)).toBe(true);
    }
  });

  test("`type` остаётся открытым словарём: имя тулзы — не 400", async () => {
    const r = await get("/api/actions?type=WEB_SEARCH");
    expect(r.status).toBe(200);
  });

  test("`agent` остаётся открытым: составной ключ — не 400", async () => {
    const r = await get("/api/actions?agent=design%3Asvg-fallback");
    expect(r.status).toBe(200);
  });
});

describe("GET /api/audit-logs — курсор", () => {
  test("нечисловой before — 400, а не свежая страница заново", async () => {
    const r = await get("/api/audit-logs?before=вчера");
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("before");
  });

  test("before_id без before — 400: тай-брейк без границы не применяется", async () => {
    const r = await get("/api/audit-logs?before_id=42");
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("before_id");
  });

  test("числовой before проходит", async () => {
    const r = await get(`/api/audit-logs?before=${Date.now()}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body?.logs ?? r.body?.auditLogs)).toBe(true);
  });

  test("без курсора — 200", async () => {
    const r = await get("/api/audit-logs");
    expect(r.status).toBe(200);
  });
});
