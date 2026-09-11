/**
 * Аудит 2026-08-21: вкладка «Агенты» узнавала о том, что пользователь не
 * админ, только из отказа на попытку записи.
 *
 * `adminBlocked` в `Agents.tsx` поднимался ровно в двух местах — в catch'ах
 * `setAgentAutonomy` и паузы, по `e.status === 403`. До первого клика страница
 * рисовала живой выпадающий список режимов и кнопку «Пауза», как будто ими
 * можно пользоваться. Не-админ выбирал режим, получал красный тост «Только для
 * админа», и только тогда появлялась плашка с объяснением.
 *
 * При этом сервер называет гейт сразу, в первом же ответе. Замерено пробой
 * (пользователь в allowedUserIds, не в adminUserIds):
 *
 *   GET  /api/budgets               → 200, admin=false
 *   GET  /api/autonomy?agent=design → 200, admin=false, mode=semi_auto
 *   POST /api/autonomy              → 403   ← только это страница и замечала
 *
 * Обе ручки страница зовёт и без того: `budgets()` — в `refresh()` на монтаже,
 * `autonomy({agent})` — на каждый ключ агента. То есть флаг уже лежал в
 * ответе, его просто выбрасывали. Соседи так не делают: Dashboard.tsx читает
 * `autonomy.admin`, Settings.tsx — `budgetsRes.admin`.
 *
 * Инвариант: запрет виден до клика, а не после.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_agents_admin_flag";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";

const BOT_TOKEN = "test_bot_token_agents_admin_flag";
const ADMIN_ID = 92_101;
const PLAIN_ID = 92_102; // в аллоу-листе, но не админ

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Agents.tsx"),
  "utf8",
);

let server: MiniappServerHandle;
let baseUrl: string;

const call = (path: string, userId: number, init?: RequestInit) =>
  fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "X-Telegram-Init-Data": buildInitData(BOT_TOKEN, {
        auth_date: String(Math.floor(Date.now() / 1000)),
        query_id: "qaa",
        user: JSON.stringify({ id: userId, first_name: "A", is_bot: false }),
      }),
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

beforeAll(async () => {
  server = await startMiniappServer({
    adminUserIds: [ADMIN_ID],
    allowedUserIds: [ADMIN_ID, PLAIN_ID],
  });
  baseUrl = `http://localhost:${server.port}`;
});
afterAll(async () => {
  await server.stop();
});

describe("сервер называет гейт на чтении, а не только на записи", () => {
  test("/api/budgets не-админу — 200 и admin:false", async () => {
    const r = await call("/api/budgets", PLAIN_ID);
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).admin).toBe(false);
  });

  test("/api/autonomy?agent=… не-админу — 200 и admin:false", async () => {
    const r = await call("/api/autonomy?agent=design", PLAIN_ID);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    expect(body.admin).toBe(false);
    // Режим читать не-админу можно — запрещена только запись.
    expect(typeof body.mode).toBe("string");
  });

  test("POST /api/autonomy не-админу — 403, как и раньше", async () => {
    // Страховка остаётся: флаг с чтения не заменяет серверный гейт.
    const r = await call("/api/autonomy", PLAIN_ID, {
      method: "POST",
      body: JSON.stringify({ mode: "auto", agent: "design" }),
    });
    expect(r.status).toBe(403);
  });

  test("админу обе ручки отдают admin:true — плашка не залипает", async () => {
    const b = await call("/api/budgets", ADMIN_ID);
    expect(((await b.json()) as any).admin).toBe(true);
    const a = await call("/api/autonomy?agent=design", ADMIN_ID);
    expect(((await a.json()) as any).admin).toBe(true);
  });
});

describe("Agents.tsx читает флаг из обоих ответов", () => {
  test("refresh() выводит запрет из /api/budgets", () => {
    expect(SRC).toContain(
      "if (budgetsRes.admin !== undefined) setAdminBlocked(!budgetsRes.admin);",
    );
  });

  test("loadAgentAutonomy выводит запрет из /api/autonomy", () => {
    expect(SRC).toContain(
      "if (r?.admin !== undefined) setAdminBlocked(!r.admin);",
    );
  });

  test("контролы по-прежнему выключаются по adminBlocked", () => {
    expect(SRC).toContain("disabled={adminBlocked || autoBusy}");
    expect(SRC).toContain("disabled={adminBlocked || pauseBusy}");
  });

  test("реакция на 403 сохранена — сеть может ответить и позже", () => {
    // Флаг с чтения опережает клик, но не отменяет отказ на записи:
    // права могли измениться между загрузкой страницы и нажатием.
    const hits = SRC.match(/setAdminBlocked\(true\)/g) ?? [];
    expect(hits.length).toBe(2);
  });
});
