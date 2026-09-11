/**
 * Аудит 2026-08-20: POST /api/autonomy отчитывался об области, которой не писал.
 *
 * Выбор области — цепочка if/else-if: agent, иначе chat, иначе global. А ответ
 * и событие шины строились из ТЕЛА ЗАПРОСА:
 *
 *     busEmit("agent.autonomy", { mode, chat_id: body.chat_id ?? null,
 *                                 agent: body.agent ?? null });
 *
 * Поэтому `{mode, agent:"backend", chat_id:-100…}` записывал одну строку
 * (роль), а отдавал обратно оба поля — как будто применены оба правила. Врал
 * не только ответ: `agent.autonomy` уходит в SSE, и лента событий фиксировала
 * область, которой никто не записывал.
 *
 * Теперь неоднозначный запрос отбивается 400 (как badAgentKey отбивает
 * опечатку в ключе роли), а ответ и шина называют ровно то, что легло в БД.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { getAutonomy } from "../lib/permissions.ts";
import { db } from "../lib/db.ts";

const BOT_TOKEN = "test_bot_token_for_autonomy_echo";
const ADMIN_ID = 515151;
const CHAT_ID = -100515151;

let server: MiniappServerHandle;
let base: string;
let restore: () => void;

function initData(userId = ADMIN_ID): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "q1",
    user: JSON.stringify({ id: userId, username: "admin", first_name: "A" }),
  });
}

async function post(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/autonomy`, {
    method: "POST",
    headers: {
      "x-telegram-init-data": initData(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeAll(() => {
  // Тест пишет живые строки autonomy_modes — в том числе глобальную. Без
  // возврата снимка режим протёк бы в соседние файлы прогона и менял бы им
  // поведение гейта (та же болячка, что T-751 с permissions; savePermissions
  // из _helpers.ts эту таблицу не трогает).
  const snapshot = db
    .prepare(`SELECT scope, scope_id, mode, updated_at FROM autonomy_modes`)
    .all() as Array<{
    scope: string;
    scope_id: string;
    mode: string;
    updated_at: number;
  }>;
  restore = () => {
    db.prepare(`DELETE FROM autonomy_modes`).run();
    const ins = db.prepare(
      `INSERT INTO autonomy_modes(scope, scope_id, mode, updated_at) VALUES (?,?,?,?)`,
    );
    for (const r of snapshot) ins.run(r.scope, r.scope_id, r.mode, r.updated_at);
  };
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
  restore();
});

describe("POST /api/autonomy — отчёт совпадает с записью", () => {
  test("agent + chat_id вместе — 400, а не тихий выбор одной области", async () => {
    const r = await post({ mode: "manual", agent: "backend", chat_id: CHAT_ID });
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("chat_id");
  });

  test("неоднозначный запрос не пишет НИЧЕГО", async () => {
    const before = getAutonomy(CHAT_ID, "qa");
    await post({ mode: "auto", agent: "qa", chat_id: CHAT_ID });
    expect(getAutonomy(CHAT_ID, "qa")).toBe(before);
  });

  test("область agent: chat_id в ответе null, а не эхо запроса", async () => {
    const r = await post({ mode: "manual", agent: "backend" });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("agent");
    expect(r.body.scope_key).toBe("backend");
    expect(r.body.agent).toBe("backend");
    expect(r.body.chat_id).toBeNull();
  });

  test("область chat: agent в ответе null", async () => {
    const r = await post({ mode: "manual", chat_id: CHAT_ID });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("chat");
    expect(r.body.chat_id).toBe(CHAT_ID);
    expect(r.body.agent).toBeNull();
  });

  test("глобальная область называет себя явно", async () => {
    const r = await post({ mode: "semi_auto" });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("global");
    expect(r.body.scope_key).toBe("*");
    expect(r.body.chat_id).toBeNull();
    expect(r.body.agent).toBeNull();
  });

  test("записанное действительно читается обратно", async () => {
    await post({ mode: "manual", agent: "backend" });
    expect(getAutonomy(undefined, "backend")).toBe("manual");
  });

  test("опечатка в ключе роли по-прежнему 400", async () => {
    const r = await post({ mode: "manual", agent: "Backend" });
    expect(r.status).toBe(400);
    expect(String(r.body?.error)).toContain("unknown agentKey");
  });

  test("пустой agent не считается заявкой на область роли", async () => {
    const r = await post({ mode: "manual", agent: "", chat_id: CHAT_ID });
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("chat");
  });

  // Аудит 2026-09-11 — второй виток того же дефекта. Адрес записи считать по
  // коду научились год назад, а САМ РЕЖИМ так и брался из тела: `inherit`
  // снимает строку (clearAutonomy), не записав ничего, а ответ и шина всё
  // равно отдавали `mode: "inherit"` — значение, которого нет ни в одной
  // строке autonomy_modes и нет в AUTONOMY_MODES. Потребителей payload'а
  // сегодня нет (Agents.tsx на событие зовёт refresh и перечитывает GET), так
  // что это дефект контракта, а не эксплуатируемая дыра; закрепляем, пока
  // первый читатель шины не поверил выдуманному режиму.
  test("inherit не выдумывает режим: mode=null, inherit=true", async () => {
    await post({ mode: "locked", agent: "backend" });
    expect(getAutonomy(undefined, "backend")).toBe("locked");

    const r = await post({ mode: "inherit", agent: "backend" });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBeNull();
    expect(r.body.inherit).toBe(true);
    expect(r.body.scope).toBe("agent");
    expect(r.body.agent).toBe("backend");
    // Строка действительно снята, а не переписана на «inherit» — которое в
    // эту колонку и не легло бы: CHECK в миграции 003_autonomy_modes
    // перечисляет ровно locked/manual/semi_auto/auto.
    const row = db
      .prepare(
        `SELECT mode FROM autonomy_modes WHERE scope = 'agent' AND scope_id = ?`,
      )
      .get("backend") as { mode?: string } | undefined;
    expect(row).toBeFalsy();
  });

  test("обычный режим по-прежнему называет себя, inherit=false", async () => {
    const r = await post({ mode: "manual", agent: "backend" });
    expect(r.body.mode).toBe("manual");
    expect(r.body.inherit).toBe(false);
  });
});
