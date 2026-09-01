/**
 * Аудит 2026-08-28: у роутера была вторая, противоположная дверь к откату.
 *
 * `getUserbotHandle` (тот же файл, ниже) держит правило, ради которого его и
 * переписывали: «Явно объявленная сессия не деградирует молча до чужой:
 * зарегистрирован, но недоступен — это отказ, а не другой аккаунт». Оператор
 * объявляет USERBOT_SESSION_SMM ровно затем, чтобы smm ходил со своего
 * аккаунта; файл сессии протухает штатно, и безусловный откат означал бы
 * подмену ЛИЧНОСТИ — действие уходит с личного аккаунта владельца.
 *
 * А методы `UserbotRouter.setReaction` / `.deleteMessage` откатывались на
 * `getCurrentUserbot()` безусловно, и их докстринги это прямо обещали
 * («Falls back to singleton userbot if agent session unavailable»). Мимо
 * `getUserbotHandle`, а заодно мимо `guardedUserbotCall` — то есть и мимо
 * флуд-гварда.
 *
 * Прод сегодня ходит не через них (`lib/dispatch/telegram.ts` резолвит handle
 * сам и зовёт `ub.setReaction`), поэтому это не утечка, а заряженная мина:
 * первый, кто подключит SET_REACTION к роутеру, получит тихую подмену.
 *
 * Правило теперь одно на оба входа. Незарегистрированный агент откатывается
 * как раньше — это исходный режим «роутера нет, все ходят через общий
 * аккаунт», и ломать его нечем.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserbotRouter } from "../lib/userbot-router.ts";
import { setCurrentUserbot } from "../lib/userbot.ts";

const SRC = readFileSync(new URL("../lib/userbot-router.ts", import.meta.url), "utf8");

afterEach(() => setCurrentUserbot(null));

/** Сессия объявлена, но файла нет — штатный «протух/не поднялся». */
function routerWithBrokenSession(): UserbotRouter {
  const router = new UserbotRouter({ onMessage: () => {}, defaultAllowedChatIds: [-1001] });
  const dir = mkdtempSync(join(tmpdir(), "ubident-"));
  router.registerAgent("smm", {
    sessionFile: join(dir, "нет-такого.session"),
    allowedChatIds: [-1001],
  });
  return router;
}

/** Живой синглтон владельца, считающий, что через него прошло. */
function ownerSingleton() {
  const calls: string[] = [];
  setCurrentUserbot({
    isNoop: false,
    async setReaction(chatId: number | string, msgId: number, emoji: string) {
      calls.push(`react ${chatId}/${msgId}/${emoji}`);
    },
    async deleteMessage(chatId: number | string, msgId: number) {
      calls.push(`del ${chatId}/${msgId}`);
    },
  } as never);
  return calls;
}

describe("объявленная, но недоступная сессия — отказ, а не чужой аккаунт", () => {
  test("setReaction не уходит на аккаунт владельца", async () => {
    const router = routerWithBrokenSession();
    const calls = ownerSingleton();
    await expect(router.setReaction("smm", -1001, 42, "👍")).rejects.toThrow(
      "No userbot session available",
    );
    expect(calls).toEqual([]);
  });

  test("deleteMessage не уходит на аккаунт владельца", async () => {
    const router = routerWithBrokenSession();
    const calls = ownerSingleton();
    await expect(router.deleteMessage("smm", -1001, 7)).rejects.toThrow(
      "No userbot session available",
    );
    expect(calls).toEqual([]);
  });

  test("в отказе названа причина, а не только факт", async () => {
    const router = routerWithBrokenSession();
    ownerSingleton();
    await expect(router.setReaction("smm", -1001, 42, "👍")).rejects.toThrow(/smm/);
    await expect(router.setReaction("smm", -1001, 42, "👍")).rejects.toThrow(/объявлена/);
  });

  test("окно остановки роутера — тот же отказ, а не подмена", async () => {
    const router = routerWithBrokenSession();
    const calls = ownerSingleton();
    await router.stopAll();
    await expect(router.deleteMessage("smm", -1001, 7)).rejects.toThrow(
      "No userbot session available",
    );
    expect(calls).toEqual([]);
  });
});

describe("исходный режим не сломан", () => {
  test("агент без объявленной сессии по-прежнему идёт через общий аккаунт", async () => {
    const router = routerWithBrokenSession();
    const calls = ownerSingleton();
    await router.setReaction("qa", -1001, 42, "👍");
    await router.deleteMessage("qa", -1001, 7);
    expect(calls).toEqual(["react -1001/42/👍", "del -1001/7"]);
  });

  test("вызов без agentKey — тоже общий аккаунт", async () => {
    const router = routerWithBrokenSession();
    const calls = ownerSingleton();
    await router.setReaction(undefined, -1001, 42, "🔥");
    expect(calls).toEqual(["react -1001/42/🔥"]);
  });

  test("поднявшаяся личная сессия по-прежнему обслуживает свои действия", async () => {
    const router = new UserbotRouter({ onMessage: () => {}, defaultAllowedChatIds: [-1001] });
    const dir = mkdtempSync(join(tmpdir(), "ubident-live-"));
    const f = join(dir, "smm.session");
    writeFileSync(f, "stub");
    router.registerAgent("smm", { sessionFile: f, allowedChatIds: [-1001] });
    const own: string[] = [];
    (router as unknown as { sessions: Map<string, unknown> }).sessions.set("smm", {
      isNoop: false,
      async setReaction(chatId: number | string, msgId: number, emoji: string) {
        own.push(`${chatId}/${msgId}/${emoji}`);
      },
      async deleteMessage() {},
      async stop() {},
    });
    const owner = ownerSingleton();
    await router.setReaction("smm", -1001, 42, "👍");
    expect(own).toEqual(["-1001/42/👍"]);
    expect(owner).toEqual([]);
  });

  test("нет ни личной сессии, ни синглтона — прежняя ошибка", async () => {
    const router = new UserbotRouter({ onMessage: () => {}, defaultAllowedChatIds: [-1001] });
    setCurrentUserbot(null);
    await expect(router.setReaction("qa", -1001, 42, "👍")).rejects.toThrow(
      "No userbot session available",
    );
  });
});

describe("применение", () => {
  const lines = SRC.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
  const has = (needle: string) => lines.some((l) => l.includes(needle));

  test("решение об откате принимается в одном месте на оба метода", () => {
    expect(has("private async resolveForAction(")).toBe(true);
    expect(lines.filter((l) => l.includes("this.resolveForAction(")).length).toBe(2);
  });

  test("прямого обращения к синглтону в этих методах не осталось", () => {
    const from = SRC.indexOf("  async setReaction(");
    const to = SRC.indexOf("  async stopAll(");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const body = SRC.slice(from, to).split("\n");
    expect(body.filter((l) => l.includes("getCurrentUserbot()"))).toEqual([]);
  });

  test("докстринги больше не обещают безусловный откат", () => {
    expect(SRC).not.toContain("Falls back to singleton userbot if agent session unavailable");
  });
});
