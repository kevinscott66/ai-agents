/**
 * Аудит 2026-08-28: живая MTProto-сессия поднималась ради веток, которые не
 * выполняются.
 *
 * `resolveUserbot`/`resolveUserbotHandle` — не геттер: у роутера это
 * `getAgentHandle` → `startSession` → `startUserbot`, то есть настоящий
 * gramjs-коннект по сети, лениво, при первом обращении. Два места звали его
 * заранее, до проверки, нужен ли он вообще.
 *
 * 1. `dispatch/misc.ts`: `LIST_RECENT_MESSAGES` — чтение своей же SQLite —
 *    резолвил userbot ПЕРЕД проверкой `typeof ubIter === "function"`. Проверка
 *    всегда ложна: `UserbotHandle` не объявляет `iterMessages` ни в одной из
 *    реализаций (`buildHandle`, `NOOP_HANDLE`), и в репозитории это слово не
 *    встречается больше нигде. Комментарий рядом сам это признавал — «current
 *    built-in handle does not — kept as a hook for future extension». Хук был
 *    мёртв с рождения, а платили за него живым соединением на каждый вызов
 *    read-only инструмента.
 *
 *    Вместе с блоком уходит и его дедупликатор: `seen` собирался из
 *    `messages.id` (autoincrement SQLite), а сверялся с `m.id` из Telegram —
 *    разные пространства номеров, совпадение случайно.
 *
 * 2. `dispatch/telegram.ts`: `handleSetReaction` резолвил handle первой
 *    строкой, хотя нужен он в трёх ветках из пяти, и все три — только для
 *    оркестратора. Обычная реакция ботом на whitelist-эмодзи (основной путь)
 *    платила за соединение, которым не пользовалась.
 *
 * Наблюдаемость: у misc-контекста `resolveUserbot` — внедряемая функция, её
 * просто считаем. У telegram-контекста тестовый шов — ЧТЕНИЕ СВОЙСТВА
 * `ctx.userbot` (`resolveUserbotHandle` начинается с `ctx.userbot !== undefined`),
 * поэтому считаем обращения к геттеру: за один резолв их два (проверка и
 * возврат), так что сравниваем с нулём, а не с единицей.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { handleListRecentMessages } from "../lib/dispatch/misc.ts";
import { handleSetReaction } from "../lib/dispatch/telegram.ts";

const CHAT = 779_101;

const MISC_SRC = readFileSync(new URL("../lib/dispatch/misc.ts", import.meta.url), "utf-8");
const TG_SRC = readFileSync(new URL("../lib/dispatch/telegram.ts", import.meta.url), "utf-8");

/**
 * Строки без комментариев. Провал `toContain` на целом файле вываливает его
 * весь в транскрипт (урок PR #813), поэтому сравниваем построчно.
 */
function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}
const MISC_LINES = codeLines(MISC_SRC);
const TG_LINES = codeLines(TG_SRC);
const hasIn = (lines: string[], needle: string) => lines.some((l) => l.includes(needle));

describe("LIST_RECENT_MESSAGES не поднимает сессию ради мёртвой ветки", () => {
  test("чтение истории из SQLite не трогает userbot вовсе", async () => {
    let resolves = 0;
    const res = await handleListRecentMessages({ chat_id: CHAT, kinds: ["all"], limit: 5 } as never, {
      agentKey: "orchestrator",
      chatId: CHAT,
      resolveUserbot: async () => {
        resolves++;
        return null;
      },
    });
    expect(res.ok).toBe(true);
    expect(resolves).toBe(0);
  });

  test("отказ по невалидному payload — тем более без сессии", async () => {
    let resolves = 0;
    const ctx = {
      agentKey: "orchestrator",
      chatId: CHAT,
      resolveUserbot: async () => {
        resolves++;
        return null;
      },
    };
    expect((await handleListRecentMessages({ chat_id: CHAT, kinds: ["nope"] } as never, ctx)).ok).toBe(
      false,
    );
    expect(resolves).toBe(0);
  });

  test("мёртвого примешивания истории в исходнике больше нет", () => {
    expect(hasIn(MISC_LINES, "iterMessages")).toBe(false);
    expect(hasIn(MISC_LINES, "ctx.resolveUserbot()")).toBe(false);
    // Дедупликатор на разных пространствах номеров ушёл вместе с блоком.
    expect(hasIn(MISC_LINES, "new Set<number>(messages.map")).toBe(false);
  });
});

/** Контекст, считающий обращения к тестовому шву `ctx.userbot`. */
function tgCtx(agentKey: string, telegram: unknown, userbot: unknown) {
  let reads = 0;
  const ctx: Record<string, unknown> = { agentKey, chatId: CHAT, telegram };
  Object.defineProperty(ctx, "userbot", {
    get() {
      reads++;
      return userbot;
    },
    enumerable: true,
    configurable: true,
  });
  return { ctx: ctx as never, reads: () => reads };
}

const okTelegram = { callApi: async () => ({}) } as never;
const failTelegram = {
  callApi: async () => {
    throw new Error("Bad Request: REACTION_INVALID");
  },
} as never;
const liveUserbot = {
  isNoop: false,
  async setReaction() {},
  async deleteMessage() {},
} as never;

describe("SET_REACTION резолвит userbot только там, где он нужен", () => {
  test("обычная реакция ботом на разрешённый эмодзи — без резолва", async () => {
    const { ctx, reads } = tgCtx("smm", okTelegram, liveUserbot);
    const r = await handleSetReaction({ messageId: 1, emoji: "👍" } as never, ctx);
    expect(r.ok).toBe(true);
    expect(reads()).toBe(0);
  });

  test("не-оркестратор с запрещённым эмодзи — отказ, сессию не поднимаем", async () => {
    const { ctx, reads } = tgCtx("smm", okTelegram, liveUserbot);
    const r = await handleSetReaction({ messageId: 1, emoji: "🫥" } as never, ctx);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.startsWith("REACTION_NOT_ALLOWED")).toBe(true);
    expect(reads()).toBe(0);
  });

  test("не-оркестратор при падении Bot API — ошибка наружу, сессию не поднимаем", async () => {
    const { ctx, reads } = tgCtx("smm", failTelegram, liveUserbot);
    await expect(handleSetReaction({ messageId: 1, emoji: "👍" } as never, ctx)).rejects.toThrow(
      "REACTION_INVALID",
    );
    expect(reads()).toBe(0);
  });

  test("не-оркестратор с via_userbot — отказ по роли раньше резолва", async () => {
    const { ctx, reads } = tgCtx("smm", okTelegram, liveUserbot);
    const r = await handleSetReaction(
      { messageId: 1, emoji: "👍", via_userbot: true } as never,
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && /orchestrator/.test(r.error)).toBe(true);
    expect(reads()).toBe(0);
  });
});

describe("ветки, которым userbot нужен, его получают", () => {
  test("явный via_userbot у оркестратора", async () => {
    const { ctx, reads } = tgCtx("orchestrator", okTelegram, liveUserbot);
    const r = await handleSetReaction(
      { messageId: 1, emoji: "🫥", via_userbot: true } as never,
      ctx,
    );
    expect(r).toEqual({ ok: true, result: { via: "userbot" } });
    expect(reads()).toBeGreaterThan(0);
  });

  test("запрещённый эмодзи у оркестратора уходит через userbot", async () => {
    const { ctx, reads } = tgCtx("orchestrator", okTelegram, liveUserbot);
    const r = await handleSetReaction({ messageId: 1, emoji: "🫥" } as never, ctx);
    expect(r).toEqual({ ok: true, result: { via: "userbot" } });
    expect(reads()).toBeGreaterThan(0);
  });

  test("падение Bot API у оркестратора уходит через userbot", async () => {
    const { ctx, reads } = tgCtx("orchestrator", failTelegram, liveUserbot);
    const r = await handleSetReaction({ messageId: 1, emoji: "👍" } as never, ctx);
    expect(r).toEqual({ ok: true, result: { via: "userbot" } });
    expect(reads()).toBeGreaterThan(0);
  });

  test("у оркестратора без userbot падение Bot API отдаёт исходную ошибку", async () => {
    const { ctx } = tgCtx("orchestrator", failTelegram, null);
    await expect(handleSetReaction({ messageId: 1, emoji: "👍" } as never, ctx)).rejects.toThrow(
      "REACTION_INVALID",
    );
  });

  test("via_userbot у оркестратора без сессии — понятный отказ", async () => {
    const { ctx } = tgCtx("orchestrator", okTelegram, null);
    const r = await handleSetReaction(
      { messageId: 1, emoji: "👍", via_userbot: true } as never,
      ctx,
    );
    expect(r).toEqual({ ok: false, error: "userbot not available" });
  });
});

describe("применение", () => {
  test("handleSetReaction не резолвит handle первой строкой", () => {
    const from = TG_SRC.indexOf("export async function handleSetReaction(");
    const to = TG_SRC.indexOf("export async function handleEditMessage(");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const body = codeLines(TG_SRC.slice(from, to));
    // Резолв остался, но не безусловным: каждое обращение — внутри ветки,
    // за проверкой роли.
    expect(hasIn(body, "const ub = await resolveUserbotHandle(ctx);")).toBe(false);
    expect(body.filter((l) => l.includes("resolveUserbotHandle(ctx)")).length).toBeGreaterThan(0);
  });

  test("соседний handleDeleteMessage резолвит так же — внутри ветки", () => {
    // Он делал это правильно и до правки; пин держит образец на месте.
    expect(hasIn(TG_LINES, "    const ub = await resolveUserbotHandle(ctx);")).toBe(true);
  });
});
