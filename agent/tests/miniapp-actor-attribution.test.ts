/**
 * Аудит 2026-08-13: два места Mini App приписывали действие не тому.
 *
 *  - `POST /api/budgets` брал автора из тела запроса (`body.updatedBy`), то
 *    есть журнал «кто урезал бюджет роли» писал строку, выбранную отправителем.
 *    Единственная мутирующая ручка, где так: соседние строят актора сами
 *    (`miniapp:${user.id}`). Восстановить настоящего автора потом нельзя —
 *    `agent_actions` эта ручка не пишет.
 *  - Строка access-лога брала `uid` из `x-telegram-init-data` ДО проверки
 *    HMAC. Запрос без подписи получал 401, но в журнале оставался произвольный
 *    чужой telegram-id: разбор «кто перебирал ручки» указывал на того, кого
 *    выбрал атакующий. Плюс id писался целиком, мимо `redactUserId`.
 *
 * Оба чинятся одинаково: актор берётся только из проверенного источника.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_attr";

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  spyOn,
} from "bun:test";
import { readFileSync } from "node:fs";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { getAllBudgetSettings, setBudget } from "../lib/token-budget.ts";
import { redactUserId } from "../lib/log.ts";

const BOT_TOKEN = "test_bot_token_attr";
const USER_ID = 44005001;
const IMPERSONATED = 987654321;
const AGENT = "backend";

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "qattr",
    user: JSON.stringify({
      id: USER_ID,
      username: "attrtest",
      first_name: "Attr",
      is_bot: false,
    }),
  });
}

/** Подделка: правильная форма, подписи нет. */
const FORGED_INIT_DATA = `user=${encodeURIComponent(
  JSON.stringify({ id: IMPERSONATED }),
)}&auth_date=${Math.floor(Date.now() / 1000)}&hash=deadbeef`;

let server: MiniappServerHandle;
let baseUrl: string;
let lines: string[] = [];
const logSpy = spyOn(console, "log");

beforeAll(async () => {
  server = await startMiniappServer({
    adminUserIds: [USER_ID],
    allowedUserIds: [USER_ID],
  });
  baseUrl = `http://localhost:${server.port}`;
  logSpy.mockImplementation(((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  }) as unknown as typeof console.log);
});

afterAll(async () => {
  logSpy.mockRestore();
  await server.stop();
  setBudget(AGENT, null); // прибираем override, заведённый тестом
});

beforeEach(() => {
  lines = [];
});

function accessLines(): string[] {
  return lines.filter((l) => l.includes("[miniapp] "));
}

describe("POST /api/budgets: автор — тот, кто подписал запрос", () => {
  test("`updatedBy` из тела игнорируется", async () => {
    const res = await fetch(`${baseUrl}/api/budgets`, {
      method: "POST",
      headers: {
        "X-Telegram-Init-Data": freshInitData(),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentKey: AGENT,
        dailyInputTokens: 12345,
        updatedBy: `miniapp:${IMPERSONATED}`,
      }),
    });
    expect(res.status).toBe(200);

    const row = getAllBudgetSettings().find((s) => s.agentKey === AGENT);
    expect(row?.dailyInputTokens).toBe(12345);
    expect(row?.updatedBy).toBe(`miniapp:${USER_ID}`);
    // Именно то, что раньше попадало в колонку.
    expect(row?.updatedBy).not.toContain(String(IMPERSONATED));
  });

  test("поле из тела больше нигде не читается", () => {
    // Мутационная проверка: без неё правку легко откатить «как было».
    const code = readFileSync(
      new URL("../lib/miniapp-server.ts", import.meta.url),
      "utf8",
    )
      .split("\n")
      // Комментарии отбрасываем: они это поле как раз и поминают.
      .filter((l) => !/^\s*(\*|\/\/)/.test(l));
    expect(code.filter((l) => l.includes("body.updatedBy"))).toEqual([]);
  });
});

describe("access-лог: id только из проверенного источника", () => {
  test("подделанный initData не попадает в лог", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      headers: { "X-Telegram-Init-Data": FORGED_INIT_DATA },
    });
    expect(res.status).toBe(401);

    const line = accessLines().find((l) => l.includes("/api/tasks"));
    expect(line).toBeDefined();
    expect(line).toContain("uid=-");
    expect(line).not.toContain(String(IMPERSONATED));
  });

  test("проверенный запрос логируется редактированным id", async () => {
    const res = await fetch(`${baseUrl}/api/tasks`, {
      headers: { "X-Telegram-Init-Data": freshInitData() },
    });
    expect(res.status).toBe(200);

    const line = accessLines().find((l) => l.includes("/api/tasks"));
    expect(line).toBeDefined();
    expect(line).toContain(`uid=${redactUserId(USER_ID)}`);
    // Политика lib/log.ts: полного telegram-id в логах быть не должно.
    expect(line).not.toContain(`uid=${USER_ID}`);
  });

  test("статичные пути логируются без id, а не с чужим", async () => {
    // До фикса заголовок читался и здесь — на пути, где аутентификации нет
    // вовсе, то есть подделка была бесплатной.
    await fetch(`${baseUrl}/healthz`, {
      headers: { "X-Telegram-Init-Data": FORGED_INIT_DATA },
    });
    const line = accessLines().find((l) => l.includes("/healthz"));
    expect(line).toBeDefined();
    expect(line).toContain("uid=-");
    expect(line).not.toContain(String(IMPERSONATED));
  });
});
