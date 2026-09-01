/**
 * GET_METRICS: телеметрия прода перестала быть общедоступной для 12 ролей
 * (аудит 2026-08-28).
 *
 * У renderMetrics() два вызывающих, и закрыт был ровно один. HTTP-ручка
 * `/metrics` fail-closed по Bearer'у: без METRICS_TOKEN — 503, без заголовка —
 * 401 (miniapp-server.ts). Инструмент GET_METRICS зовёт ту же функцию напрямую,
 * при этом он в INLINE_TOOL_NAMES, то есть коротко замыкается ДО gateOrDispatch
 * (ни CALLER_RESTRICTED, ни строка permissions к нему не применяются), а в
 * ROLE_EXPOSED_TOOLS его не было — значит isToolExposedToRole отвечал true
 * всем ролям.
 *
 * Что утекало: mac_bridge_connected — тот самый «поднят ли мост к машине
 * владельца», который 2026-08-12 убрали из публичного /api/health (см.
 * комментарий у ручки), — плюс tasks_open, approvals_pending, messages_stored,
 * agent_actions_recent и версия сборки. Сценарий отказа: prompt-injection в
 * любой из ролей (smm/copy/design/…) просит «покажи метрики» и получает карту
 * состояния прода одним tool-call'ом.
 */
import { describe, test, expect } from "bun:test";
import { executeTool, INLINE_TOOL_NAMES } from "../lib/tools-schema.ts";
import {
  ROLE_EXPOSED_TOOLS,
  CALLER_RESTRICTED,
  isToolExposedToRole,
} from "../lib/permissions.ts";
// Роли перечислены литералом намеренно: импорт characters/index.ts из этого
// файла разворачивает цикл tools-schema → agent-sdk-runtime → tools-schema и
// роняет весь файл на "Cannot access 'INLINE_TOOL_NAMES' before initialization".
// Длину списка сторожит тест ниже.
const ROLE_KEYS = [
  "orchestrator",
  "pm",
  "product",
  "backend",
  "frontend",
  "tgdev",
  "aieng",
  "qa",
  "smm",
  "copy",
  "design",
  "perm",
];

const ctx = (agentKey: string) => ({ agentKey, chatId: -1, telegram: {} }) as any;

async function call(role: string) {
  return JSON.parse(await executeTool("GET_METRICS", {}, ctx(role))) as {
    ok: boolean;
    error?: string;
    metrics?: string;
    format?: string;
  };
}

const ALLOWED = ["aieng", "orchestrator"] as const;

describe("GET_METRICS закрыт ролью", () => {
  test("запись в ROLE_EXPOSED_TOOLS есть и она узкая", () => {
    const list = ROLE_EXPOSED_TOOLS.GET_METRICS;
    expect(list).toBeDefined();
    expect([...(list ?? [])].sort()).toEqual([...ALLOWED].sort());
  });

  test("чужая роль получает отказ вместо метрик", async () => {
    const out = await call("smm");
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/forbidden/);
    // Главное: в ответе нет ни строчки телеметрии.
    expect(out.metrics).toBeUndefined();
  });

  test("отказ у всех ролей, кроме двух разрешённых", async () => {
    expect(ROLE_KEYS.length).toBe(12);
    const others = ROLE_KEYS.filter((r) => !(ALLOWED as readonly string[]).includes(r));
    expect(others.length).toBe(10);
    for (const role of others) {
      expect(isToolExposedToRole("GET_METRICS", role)).toBe(false);
    }
  });

  test("разрешённые роли метрики получают", async () => {
    for (const role of ALLOWED) {
      const out = await call(role);
      expect(out.ok).toBe(true);
      expect(out.format).toBe("prometheus");
      expect(typeof out.metrics).toBe("string");
    }
  });

  test("mac_bridge_connected чужой роли не виден", async () => {
    // Именно этот сигнал закрывали в /api/health 2026-08-12 — проверяем
    // предметно, а не только код ошибки.
    const out = await call("design");
    expect(JSON.stringify(out)).not.toContain("mac_bridge_connected");
    const ok = await call("orchestrator");
    expect(ok.metrics ?? "").toContain("mac_bridge_connected");
  });
});

describe("гейт живёт в общем месте, а не в хендлере", () => {
  test("GET_METRICS числится инлайновым — значит проверка нужна в карте", () => {
    // Если инструмент перестанет быть инлайновым, отказ придёт из gateOrDispatch
    // и этот тест напомнит перепроверить путь.
    expect(INLINE_TOOL_NAMES.has("GET_METRICS")).toBe(true);
  });

  test("проверка роли для инлайновых тулз читает именно эти карты", () => {
    // Гейт (tools-schema.ts) зовёт isToolExposedToRole, а тот смотрит только в
    // CALLER_RESTRICTED и ROLE_EXPOSED_TOOLS. Если запись переедет в другую
    // карту — тест ниже поймает молчаливое «всем можно».
    expect(CALLER_RESTRICTED.GET_METRICS).toBeUndefined();
    expect(ROLE_EXPOSED_TOOLS.GET_METRICS).toBeDefined();
    expect(isToolExposedToRole("GET_METRICS", "aieng")).toBe(true);
    expect(isToolExposedToRole("GET_METRICS", "backend")).toBe(false);
  });
});
