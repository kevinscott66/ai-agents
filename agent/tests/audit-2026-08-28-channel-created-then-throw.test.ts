/**
 * Аудит 2026-08-28: канал уже существовал в Telegram, а действие отчитывалось
 * так, будто не случилось ничего.
 *
 * `handleCreateTeamChannel` держит в одном `try` не только сам вызов юзербота,
 * но и всё, что идёт ПОСЛЕ создания: `registerTeamChannel` (запись в БД),
 * `noteFloodWait`, логи. Любой бросок оттуда попадал в общий `catch`, который
 * возвращает голое `{ ok: false, error }` — без `sideEffect`.
 *
 * Два следствия, и оба плохие ровно для этого действия:
 *
 *  1. `gateOrDispatch` рефандит слот рейт-лимита всем провалам, кроме
 *     помеченных `sideEffect` (action-dispatch.ts, аудит 2026-08-21). То есть
 *     ход, создавший канал в аккаунте владельца, слота не стоил.
 *  2. Модель читает «не получилось» и делает единственное разумное — повторяет.
 *     А `CreateChannel` неидемпотентен: `maxFloodRetries: 0` стоит в этом же
 *     файле именно потому, что «создание канала необратимо, повтор плодит
 *     второй». Первый канал при этом остаётся висеть, удалять его человеку
 *     руками, и в реестр он не попал — постить туда всё равно нельзя.
 *
 * Путь не теоретический: `registerTeamChannel` — это INSERT в SQLite, и он
 * бросает на любой нештатной привязке (см. «предпосылки»), не говоря про
 * занятую БД или диск. Соседний аудит 2026-08-27 уже проходил ровно этот
 * разбор для audit-записи и поставил там `sideEffect: true` со словами: флаг
 * читает gateOrDispatch, а `retryable: false` — модель.
 *
 * Инвариант: если канал создан, провал ЛЮБОГО последующего шага сообщается как
 * провал с побочным эффектом и называет channel_id — иначе о канале не узнает
 * никто, а модель заведёт второй.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { handleCreateTeamChannel } from "../lib/dispatch/channel.ts";
import { registerTeamChannel, isTeamChannel } from "../lib/team-channels.ts";
import { _resetFloodCooldowns } from "../lib/userbot-flood.ts";
import { db } from "../lib/db.ts";

const CHAT = -559001;
const CHANNEL = -1004343;

beforeEach(() => {
  _resetFloodCooldowns();
});

afterEach(() => {
  _resetFloodCooldowns();
  db.prepare(`DELETE FROM team_channels WHERE created_by_chat = ?`).run(CHAT);
});

/**
 * Заглушка юзербота. `title` намеренно параметризуем: нештатное значение
 * оттуда — самый короткий детерминированный способ уронить именно
 * пост-создательный шаг, ничего не подменяя в проде.
 */
function ctx(createTeamChannel: (t: string, a: string, u: string[]) => Promise<unknown>) {
  return {
    agentKey: "orchestrator",
    chatId: CHAT,
    resolveAgent: (role: string) => ({ username: `@${role}_bot` }) as never,
    resolveUserbot: async () => ({ isNoop: false, createTeamChannel }) as never,
  } as never;
}

async function create(createTeamChannel: (t: string, a: string, u: string[]) => Promise<unknown>) {
  const r = await handleCreateTeamChannel(
    { title: "Канал", roles: ["smm"] } as never,
    ctx(createTeamChannel),
  );
  return r as { ok: boolean; error?: string; sideEffect?: boolean; result?: Record<string, unknown> };
}

/** Канал создан, но `title` не строка — регистрация в БД бросит на привязке. */
const createdThenThrows = async (_t: string, _a: string, u: string[]) => ({
  channelId: CHANNEL,
  title: { bad: true },
  added: u,
  failed: [],
});

describe("предпосылки", () => {
  test("регистрация канала действительно может бросить", () => {
    expect(() => registerTeamChannel(CHANNEL, { bad: true } as never, CHAT)).toThrow();
  });

  test("рефанд слота выключает именно sideEffect, а не retryable", () => {
    const src = readFileSync(new URL("../lib/action-dispatch.ts", import.meta.url), "utf-8");
    expect(src).toContain("if (res.sideEffect) refundNeeded = false;");
  });

  test("необратимость создания канала записана рядом с кодом", () => {
    const src = readFileSync(new URL("../lib/dispatch/build-payload.ts", import.meta.url), "utf-8");
    expect(src).toContain("создание канала необратимо");
  });
});

describe("провал после создания не выглядит как «ничего не произошло»", () => {
  test("помечен побочным эффектом — слот не рефандится", async () => {
    const r = await create(createdThenThrows);
    expect(r.ok).toBe(false);
    expect(r.sideEffect).toBe(true);
  });

  test("ошибка называет channel_id — иначе канал не найти", async () => {
    const r = await create(createdThenThrows);
    expect(String(r.error)).toContain(String(CHANNEL));
  });

  test("ошибка говорит, что делать: не повторять, звать человека", async () => {
    const r = await create(createdThenThrows);
    const err = String(r.error);
    expect(err).toContain("Не создавай второй");
    expect(err).toContain("человек");
  });

  test("причина не теряется — исходный текст ошибки внутри", async () => {
    const r = await create(createdThenThrows);
    expect(String(r.error)).toMatch(/Binding|bind/i);
  });

  test("в реестр канал не попал — постить туда нельзя, и это честно", async () => {
    await create(createdThenThrows);
    expect(isTeamChannel(CHANNEL, CHAT)).toBe(false);
  });
});

describe("провал ДО создания остаётся обычным провалом", () => {
  test("бросок самого createTeamChannel — без sideEffect, повтор безопасен", async () => {
    const r = await create(async () => {
      throw new Error("CHANNELS_TOO_MUCH");
    });
    expect(r.ok).toBe(false);
    expect(r.sideEffect).toBeUndefined();
    expect(String(r.error)).toContain("CHANNELS_TOO_MUCH");
  });

  test("юзербот недоступен — тоже без sideEffect", async () => {
    const r = await handleCreateTeamChannel(
      { title: "Канал", roles: ["smm"] } as never,
      {
        agentKey: "orchestrator",
        chatId: CHAT,
        resolveAgent: (role: string) => ({ username: `@${role}_bot` }) as never,
        resolveUserbot: async () => null,
      } as never,
    );
    expect(r.ok).toBe(false);
    expect((r as { sideEffect?: boolean }).sideEffect).toBeUndefined();
  });
});

describe("успешный путь не тронут", () => {
  test("канал создан и зарегистрирован", async () => {
    const r = await create(async (t, _a, u) => ({
      channelId: CHANNEL,
      title: t,
      added: u,
      failed: [],
    }));
    expect(r.ok).toBe(true);
    expect(r.result?.channelId).toBe(CHANNEL);
    expect(isTeamChannel(CHANNEL, CHAT)).toBe(true);
  });
});
