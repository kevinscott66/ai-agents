/**
 * Аудит 2026-08-21: переопределение режима на уровне роли было невидимым,
 * несносимым и молча сильнее рубильника.
 *
 * Замер до починки:
 *
 *   1. perm проводит CHANGE_AGENT_STATUS{design → auto} — разовая, как
 *      кажется, настройка одной роли
 *   2. неделю спустя владелец набирает /autonomy locked:
 *      ответ бота: "Autonomy для чата -1000777 → locked."
 *   3. что на самом деле:
 *      smm     getAutonomy=locked  гейт=deny
 *      design  getAutonomy=auto    гейт=allow
 *   4. владелец переспрашивает /autonomy:
 *      ответ бота: "Текущий autonomy для чата -1000777: locked"
 *
 * (Шаг 3 — замер ДО аудита 2026-08-20: с тех пор chat=`locked` строкой роли не
 * перекрывается. Остальной приоритет agent → chat → global на месте, и все три
 * следствия ниже от этого не изменились.)
 *
 * Три следствия, и ни одно не про саму precedence (она намеренная, T-313
 * finding #5: роль, поставленную на паузу, чатовый `auto` будить не должен):
 *
 *  - подтверждение команды утверждало то, чего не произошло;
 *  - чтение возвращало не тот режим, по которому будет принято решение —
 *    `cmdAutonomy` зовёт `getAutonomy(chatId)` без agentKey, гейт зовёт с ним;
 *  - снять переопределение было нечем: `setAutonomy` умеет только upsert, а
 *    DELETE в проде-коде отсутствовал. То есть approval-карточка на смену
 *    статуса роли по факту выдавала бессрочное исключение из будущего
 *    рубильника, о чём на карточке ничего не написано.
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_autonomy_override";

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import {
  getAutonomy,
  setAutonomy,
  clearAutonomy,
  listAgentAutonomyOverrides,
} from "../lib/permissions.ts";
import { cmdAutonomy } from "../lib/commands.ts";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";

const CHAT = -1_000_777;
// Чат без стоп-крана: на нём и видно, что строка роли вообще действует.
// В `CHAT` она перекрыта — аудит 2026-08-20 сделал chat=`locked` неперекрываемым
// (`audit-2026-08-20-autonomy-locked-precedence.test.ts`), и мерить там наличие
// строки нечем: `getAutonomy` вернёт `locked` и со строкой, и без неё.
const OPEN_CHAT = -1_000_778;

// `tests/_setup.ts` чистит autonomy_modes перед каждым тестом (T-812), поэтому
// готовим состояние здесь, а убирать за собой не нужно.
beforeEach(() => {
  setAutonomy("agent", "design", "auto");
  setAutonomy("chat", String(CHAT), "locked");
});

describe("listAgentAutonomyOverrides", () => {
  test("возвращает роли со своей строкой, а не эффективный режим всех", () => {
    expect(listAgentAutonomyOverrides()).toEqual([
      { agent: "design", mode: "auto" },
    ]);
  });

  test("после clearAutonomy строки нет и роль слушается чата", () => {
    // До снятия строка роли решает: в чате без стоп-крана — `auto`.
    expect(getAutonomy(OPEN_CHAT, "design")).toBe("auto");
    expect(clearAutonomy("agent", "design")).toBe(true);
    expect(listAgentAutonomyOverrides()).toEqual([]);
    // После — роль падает на общий дефолт (у `OPEN_CHAT` своей строки нет)
    // и на стоп-кран там, где он есть.
    expect(getAutonomy(OPEN_CHAT, "design")).toBe("semi_auto");
    expect(getAutonomy(CHAT, "design")).toBe("locked");
  });

  test("снять несуществующее — false, а не бросок", () => {
    expect(clearAutonomy("agent", "design")).toBe(true);
    expect(clearAutonomy("agent", "design")).toBe(false);
  });
});

describe("/autonomy говорит правду о том, чего не затронул", () => {
  test("при установке режима называет роли с переопределением", () => {
    // `OPEN_CHAT` — чат без стоп-крана: там строка роли действительно решает.
    const out = cmdAutonomy({ chatId: OPEN_CHAT, mode: "semi_auto" });
    expect(out).toContain("→ semi_auto");
    expect(out).toContain("design=auto");
    expect(out).toContain("Не затронуты");
  });

  test("при чтении — тоже", () => {
    const out = cmdAutonomy({ chatId: OPEN_CHAT });
    expect(out).toContain("design=auto");
  });

  test("переопределений нет — приписки нет", () => {
    clearAutonomy("agent", "design");
    const out = cmdAutonomy({ chatId: CHAT, mode: "locked" });
    expect(out).toBe(`Autonomy для чата ${CHAT} → locked.`);
  });

  test("неизвестный режим по-прежнему ошибка, без приписки", () => {
    const out = cmdAutonomy({ chatId: CHAT, mode: "turbo" as never });
    expect(out).toContain("Неизвестный режим");
    expect(out).not.toContain("design=auto");
  });
});

describe("/api/autonomy — переопределение видно и снимается", () => {
  const BOT_TOKEN = "test_bot_token_autonomy_override";
  const USER_ID = 99_777;
  let server: MiniappServerHandle;
  let baseUrl: string;

  const initData = () =>
    buildInitData(BOT_TOKEN, {
      auth_date: String(Math.floor(Date.now() / 1000)),
      query_id: "qao",
      user: JSON.stringify({ id: USER_ID, first_name: "AO", is_bot: false }),
    });

  const call = (path: string, init?: RequestInit) =>
    fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "X-Telegram-Init-Data": initData(),
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

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

  test("GET отдаёт agent_overrides — иначе эффективный mode их не выдаёт", async () => {
    const r = await call(`/api/autonomy?chat_id=${CHAT}`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      mode: string;
      agent_overrides: Array<{ agent: string; mode: string }>;
    };
    // Тот самый разрыв: чат в locked, а у design своя строка.
    expect(body.mode).toBe("locked");
    expect(body.agent_overrides).toEqual([{ agent: "design", mode: "auto" }]);
  });

  test("POST mode=inherit снимает строку роли", async () => {
    const r = await call("/api/autonomy", {
      method: "POST",
      body: JSON.stringify({ agent: "design", mode: "inherit" }),
    });
    expect(r.status).toBe(200);
    expect(listAgentAutonomyOverrides()).toEqual([]);
    expect(getAutonomy(OPEN_CHAT, "design")).toBe("semi_auto");
    expect(getAutonomy(CHAT, "design")).toBe("locked");
  });

  test("inherit без agent — 400: наследовать чату не от кого", async () => {
    const r = await call("/api/autonomy", {
      method: "POST",
      body: JSON.stringify({ chat_id: CHAT, mode: "inherit" }),
    });
    expect(r.status).toBe(400);
    // Чатовый режим не тронут.
    expect(getAutonomy(CHAT)).toBe("locked");
  });

  test("прочие несуществующие режимы по-прежнему 400", async () => {
    const r = await call("/api/autonomy", {
      method: "POST",
      body: JSON.stringify({ agent: "design", mode: "turbo" }),
    });
    expect(r.status).toBe(400);
    expect(listAgentAutonomyOverrides()).toEqual([
      { agent: "design", mode: "auto" },
    ]);
  });

  test("обычная установка режима роли работает как работала", async () => {
    const r = await call("/api/autonomy", {
      method: "POST",
      body: JSON.stringify({ agent: "qa", mode: "manual" }),
    });
    expect(r.status).toBe(200);
    expect(listAgentAutonomyOverrides()).toEqual([
      { agent: "design", mode: "auto" },
      { agent: "qa", mode: "manual" },
    ]);
  });
});
