/**
 * C25 / M3 — Mini App UX polish:
 *  - GET /api/budgets shape
 *  - themeParamsToVars (pure helper, no DOM)
 *  - parseLogsHash / serializeLogsHash round-trip
 */
process.env.MINIAPP_BOT_TOKEN = "test_bot_token_for_c25";

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildInitData } from "../lib/miniapp-auth.ts";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";

const BOT_TOKEN = "test_bot_token_for_c25";
const USER_ID = 24680;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function freshInitData(): string {
  return buildInitData(BOT_TOKEN, {
    auth_date: String(nowSec()),
    query_id: "qc25",
    user: JSON.stringify({ id: USER_ID, username: "ux", first_name: "U" }),
  });
}

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  // Set a specific budget so the endpoint surfaces a non-null limit for
  // at least one agent regardless of test ordering.
  process.env.TOKEN_BUDGET_DEFAULT = "100000";
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [USER_ID],
    botToken: BOT_TOKEN,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  delete process.env.TOKEN_BUDGET_DEFAULT;
});

describe("C25 GET /api/budgets", () => {
  test("auth wall: missing initData → 401", async () => {
    const r = await fetch(`${base}/api/budgets`);
    expect(r.status).toBe(401);
  });

  test("returns budgets array with expected shape", async () => {
    const r = await fetch(`${base}/api/budgets`, {
      headers: { "x-telegram-init-data": freshInitData() },
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      budgets: {
        agentKey: string;
        usedTokens: number;
        outputTokens: number;
        limit: number | null;
        resetAt: number;
      }[];
    };
    expect(Array.isArray(body.budgets)).toBe(true);
    expect(body.budgets.length).toBeGreaterThan(0);
    const b = body.budgets[0];
    expect(typeof b.agentKey).toBe("string");
    expect(typeof b.usedTokens).toBe("number");
    expect(typeof b.outputTokens).toBe("number");
    expect(typeof b.resetAt).toBe("number");
    expect(b.resetAt).toBeGreaterThan(Date.now());
    // With TOKEN_BUDGET_DEFAULT set, limit must be numeric.
    expect(b.limit).toBe(100000);
  });
});

describe("C25 themeParamsToVars", () => {
  test("maps Telegram themeParams → CSS vars", async () => {
    const { themeParamsToVars } = await import("../miniapp/src/lib/theme.ts");
    const vars = themeParamsToVars({
      bg_color: "#101010",
      text_color: "#fafafa",
      hint_color: "#888888",
      button_color: "#2481cc",
      button_text_color: "#ffffff",
      link_color: "#1d8ce0",
      secondary_bg_color: "#1a1a1a",
    });
    expect(vars["--tg-bg"]).toBe("#101010");
    expect(vars["--tg-text"]).toBe("#fafafa");
    expect(vars["--tg-button"]).toBe("#2481cc");
    expect(vars["--tg-secondary-bg"]).toBe("#1a1a1a");
  });

  test("handles null/undefined and ignores unknown keys", async () => {
    const { themeParamsToVars } = await import("../miniapp/src/lib/theme.ts");
    expect(themeParamsToVars(null)).toEqual({});
    expect(themeParamsToVars(undefined)).toEqual({});
    const vars = themeParamsToVars({ bg_color: "#fff", junk: "x" } as any);
    expect(vars["--tg-bg"]).toBe("#fff");
    expect(Object.keys(vars).length).toBe(1);
  });
});

describe("C25 Logs URL hash filter", () => {
  test("parseLogsHash extracts filters; serialize round-trips", async () => {
    const mod = await import("../miniapp/src/pages/Logs.tsx");
    const { parseLogsHash, serializeLogsHash } = mod as any;
    const parsed = parseLogsHash("#agent=backend&q=err%20boom&level=error");
    expect(parsed.agent).toBe("backend");
    expect(parsed.q).toBe("err boom");
    expect(parsed.level).toBe("error");
    expect(parsed.status).toBe("");

    const round = serializeLogsHash(parsed);
    const re = parseLogsHash(round);
    expect(re).toEqual(parsed);

    // Empty filters → empty hash.
    expect(
      serializeLogsHash({ agent: "", q: "", level: "", status: "", type: "" }),
    ).toBe("");
  });
});
