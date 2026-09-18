/**
 * SHOP_REPAIR на сервере (lib/shop-repair.ts) и замок покупок на время починки
 * (ShopRunner.hold). Агент запускает починку сам, итог приходит отложенной
 * проверкой, потолки не дают зацикленному агенту наплодить PR.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { db } from "../lib/db.ts";
import { activeFollowups } from "../lib/followups.ts";
import {
  REPAIR_COOLDOWN_MS,
  REPAIR_STALE_MS,
  _setSendRepairForTests,
  getRepair,
  repairFollowupTask,
  runRepairInBackground,
  shopRepairTool,
} from "../lib/shop-repair.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { SHOP_RECOVERY } from "../lib/shop.ts";
import { ShopRunner } from "../mac-daemon/shop.ts";

const OWNER = "918000927";
const OWNER_CHAT = Number(OWNER);
const HOUR = 3_600_000;

let savedOwners: string | undefined;
beforeAll(() => {
  savedOwners = process.env.MINIAPP_ADMIN_USER_IDS;
  process.env.MINIAPP_ADMIN_USER_IDS = OWNER;
});
afterAll(() => {
  if (savedOwners === undefined) delete process.env.MINIAPP_ADMIN_USER_IDS;
  else process.env.MINIAPP_ADMIN_USER_IDS = savedOwners;
  _setSendRepairForTests(null);
});
afterEach(() => {
  db.prepare(`DELETE FROM selector_repairs`).run();
  db.prepare(`DELETE FROM followups WHERE chat_id = ?`).run(OWNER_CHAT);
  _resetRateLimits();
});

const ownerCtx = { agentKey: "orchestrator", chatId: OWNER_CHAT, triggerUserId: OWNER, delegationChain: ["orchestrator"] };
const PR = "https://github.com/o/r/pull/5";
const okOutcome = JSON.stringify({ ok: true, branch: "b", pr_url: PR, changed: [], empty_before: [], empty_after: [] });

/** Отправка, которая ждёт, пока тест её отпустит. */
function pendingSend() {
  let finish!: (stdout: string) => void;
  const sent: unknown[] = [];
  _setSendRepairForTests((req) => {
    sent.push(req);
    return new Promise((resolve) => {
      finish = (stdout) => resolve({ ok: true, stdout, stderr: "" });
    });
  });
  return { sent, finish: (s: string) => finish(s) };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe("SHOP_REPAIR", () => {
  test("только оркестратор в личке владельца", () => {
    pendingSend();
    expect(shopRepairTool({ service: "lavka", code: "unexpected_page" }, { ...ownerCtx, agentKey: "backend" }).ok).toBe(false);
    expect(shopRepairTool({ service: "lavka", code: "unexpected_page" }, { ...ownerCtx, chatId: -100 }).ok).toBe(false);
    expect(shopRepairTool({ service: "lavka", code: "unexpected_page" }, { ...ownerCtx, delegationChain: ["backend", "orchestrator"] }).ok).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM selector_repairs`).get()).toEqual({ n: 0 });
  });

  test("неизвестный код — отказ до запуска", () => {
    const s = pendingSend();
    expect(shopRepairTool({ service: "lavka", code: "captcha" }, ownerCtx).ok).toBe(false);
    expect(s.sent).toEqual([]);
  });

  test("запуск сразу отвечает, итог с PR приходит проверкой", async () => {
    const s = pendingSend();
    const out = JSON.parse(await executeTool("SHOP_REPAIR", { service: "eda", code: "price_unreadable" }, ownerCtx));
    expect(out).toMatchObject({ ok: true, started: true });
    expect(s.sent).toEqual([{ service: "eda", code: "price_unreadable" }]);
    expect(getRepair(out.id)!.status).toBe("running");
    s.finish(`${okOutcome}\n`);
    await flush();
    expect(getRepair(out.id)).toMatchObject({ status: "done", pr_url: PR });
    const [f] = activeFollowups(OWNER_CHAT);
    expect(f.task).toContain(PR);
    expect(f.task).toContain("Сам не мержи");
  });

  test("одна починка одновременно, сервис раз в 12 часов", async () => {
    const s = pendingSend();
    const now = Date.now();
    expect(shopRepairTool({ service: "lavka", code: "unexpected_page" }, ownerCtx, now).ok).toBe(true);
    const busy = shopRepairTool({ service: "eda", code: "unexpected_page" }, ownerCtx, now + 1000);
    expect(busy).toMatchObject({ ok: false });
    expect(String(busy.error)).toContain("уже идёт");
    s.finish(JSON.stringify({ ok: false, code: "repair_no_change" }));
    await flush();
    expect(String(shopRepairTool({ service: "lavka", code: "unexpected_page" }, ownerCtx, now + HOUR).error)).toContain("12 часов");
    expect(shopRepairTool({ service: "lavka", code: "unexpected_page" }, ownerCtx, now + REPAIR_COOLDOWN_MS + 1000).ok).toBe(true);
  });

  test("не больше трёх за сутки", async () => {
    const now = Date.now();
    for (const [i, service] of (["lavka", "eda", "market"] as const).entries()) {
      db.prepare(`INSERT INTO selector_repairs (id, service, code, chat_id, user_id, status, created_at) VALUES (?, ?, 'unexpected_page', ?, ?, 'failed', ?)`).run(
        `x${i}`, service, OWNER_CHAT, OWNER, now - REPAIR_COOLDOWN_MS - 1000 - i,
      );
    }
    pendingSend();
    expect(String(shopRepairTool({ service: "lavka", code: "unexpected_page" }, ownerCtx, now).error)).toContain("максимум 3");
  });

  test("застрявший running после рестарта становится failed", () => {
    const now = Date.now();
    db.prepare(`INSERT INTO selector_repairs (id, service, code, chat_id, user_id, status, created_at) VALUES ('old', 'market', 'unexpected_page', ?, ?, 'running', ?)`).run(
      OWNER_CHAT, OWNER, now - REPAIR_STALE_MS - 1000,
    );
    pendingSend();
    expect(shopRepairTool({ service: "lavka", code: "unexpected_page" }, ownerCtx, now).ok).toBe(true);
    expect(getRepair("old")).toMatchObject({ status: "failed", error: "stale" });
  });

  test("Mac не ответил или ответил мусором — failed и сообщение владельцу", async () => {
    _setSendRepairForTests(async () => {
      throw new Error("mac_offline");
    });
    const now = Date.now();
    db.prepare(`INSERT INTO selector_repairs (id, service, code, chat_id, user_id, status, created_at) VALUES ('m1', 'lavka', 'unexpected_page', ?, ?, 'running', ?)`).run(OWNER_CHAT, OWNER, now);
    await runRepairInBackground(getRepair("m1")!, { service: "lavka", code: "unexpected_page" });
    expect(getRepair("m1")).toMatchObject({ status: "failed", error: "mac_offline" });
    expect(activeFollowups(OWNER_CHAT)[0].task).toContain("не дала ответа Mac");
  });

  test("задача проверки влезает в 300 символов", () => {
    const req = { service: "market", code: "price_unreadable" } as const;
    for (const o of [null, JSON.parse(okOutcome), { ok: false, code: "repair_forbidden_paths" }, { ok: false, code: "repair_no_change" }]) {
      expect(repairFollowupTask(req, o).length).toBeLessThanOrEqual(300);
    }
  });

  test("отказы вёрстки ведут к SHOP_REPAIR", () => {
    expect(SHOP_RECOVERY.unexpected_page.next).toContain("SHOP_REPAIR");
    expect(SHOP_RECOVERY.price_unreadable.next).toContain("SHOP_REPAIR");
    expect(SHOP_RECOVERY.unexpected_page.owner).toBe(false);
  });
});

describe("замок покупок на время починки", () => {
  const runner = () =>
    new ShopRunner({ SHOP_ENABLED: "true", SHOP_PROFILE_DIR: "/profile" }, {
      checkProfile: () => "/profile",
      launch: async () => {
        throw new Error("браузер в тесте не нужен");
      },
    });

  test("пока держит починка — покупки shop_busy без busy_op, reset не рвёт", async () => {
    const r = runner();
    const release = await r.hold();
    expect(release).not.toBeNull();
    expect(await r.hold()).toBeNull();
    const busy = await r.run({ op: "status" } as never);
    expect(busy).toEqual({ ok: false, code: "shop_busy" });
    expect(await r.run({ op: "reset" } as never)).toEqual({ ok: true, op: "reset", reset: false });
    release!();
    release!();
    const again = await r.hold();
    expect(again).not.toBeNull();
    again!();
  });
});
