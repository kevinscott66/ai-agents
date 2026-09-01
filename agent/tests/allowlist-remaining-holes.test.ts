/**
 * Аудит 2026-08-09: две границы allowlist, не переведённые на fail-closed.
 *
 * 1) Admin-команды Lead-бота регистрируются на том же Telegraf-инстансе, что и
 *    message/voice хендлеры, но allowlist чата в них не передавался вовсе.
 * 2) Ингест userbot'а (личный аккаунт владельца) держал старый fail-open
 *    `if (!allowed.length) return true` — ровно тот паттерн, ради удаления
 *    которого написан lib/allowlist.ts.
 */
import { describe, test, expect, mock, afterEach } from "bun:test";
import { registerAdminCommands } from "../lib/admin-commands.ts";
import { makeHandler } from "../lib/userbot.ts";
import type { UserbotMessageEvent } from "../lib/userbot.ts";

const ALLOWED_CHAT = "-1002000000001";
const OUTSIDE_CHAT = "-1002000000999";

const savedAdmins = process.env.TELEGRAM_ADMIN_USER_IDS;
afterEach(() => {
  if (savedAdmins === undefined) delete process.env.TELEGRAM_ADMIN_USER_IDS;
  else process.env.TELEGRAM_ADMIN_USER_IDS = savedAdmins;
});

/**
 * Мини-заглушка Telegraf: `command(name, fn)` просто складывает хендлеры,
 * потом дёргаем нужный руками с поддельным ctx.
 */
function fakeBot() {
  const handlers = new Map<string, (ctx: unknown) => Promise<void>>();
  const bot = {
    command(name: string, fn: (ctx: unknown) => Promise<void>) {
      handlers.set(name, fn);
    },
  };
  return { bot, handlers };
}

function fakeCtx(chatId: string, fromId: number, text: string) {
  const reply = mock(async (_s: string) => {});
  return {
    ctx: { chat: { id: Number(chatId) }, from: { id: fromId }, message: { text }, reply },
    reply,
  };
}

describe("allowlist чата действует и на admin-командах", () => {
  test("команда из чужого чата остаётся без ответа", async () => {
    process.env.TELEGRAM_ADMIN_USER_IDS = "777";
    const { bot, handlers } = fakeBot();
    registerAdminCommands(bot as never, { resolveTg: () => undefined }, [ALLOWED_CHAT]);

    const { ctx, reply } = fakeCtx(OUTSIDE_CHAT, 777, "/perms");
    await handlers.get("perms")!(ctx);

    // Даже админу — молчание: обещание «бот не разговаривает вне разрешённых
    // чатов» сильнее, чем удобство ответа. До фикса приходил полный список прав.
    expect(reply).not.toHaveBeenCalled();
  });

  test("посторонний в чужом чате не получает даже отказ", async () => {
    process.env.TELEGRAM_ADMIN_USER_IDS = "777";
    const { bot, handlers } = fakeBot();
    registerAdminCommands(bot as never, { resolveTg: () => undefined }, [ALLOWED_CHAT]);

    const { ctx, reply } = fakeCtx(OUTSIDE_CHAT, 31337, "/approve abc");
    await handlers.get("approve")!(ctx);

    // «⛔ только для админов» — это подтверждение, что у бота есть админская
    // поверхность, выданное незнакомцу вне allowlist. До фикса приходило.
    expect(reply).not.toHaveBeenCalled();
  });

  test("в разрешённом чате админ по-прежнему получает ответ", async () => {
    process.env.TELEGRAM_ADMIN_USER_IDS = "777";
    const { bot, handlers } = fakeBot();
    registerAdminCommands(bot as never, { resolveTg: () => undefined }, [ALLOWED_CHAT]);

    const { ctx, reply } = fakeCtx(ALLOWED_CHAT, 777, "/perms");
    await handlers.get("perms")!(ctx);

    expect(reply).toHaveBeenCalled();
  });

  test("в разрешённом чате не-админ получает отказ", async () => {
    process.env.TELEGRAM_ADMIN_USER_IDS = "777";
    const { bot, handlers } = fakeBot();
    registerAdminCommands(bot as never, { resolveTg: () => undefined }, [ALLOWED_CHAT]);

    const { ctx, reply } = fakeCtx(ALLOWED_CHAT, 31337, "/approve abc");
    await handlers.get("approve")!(ctx);

    expect(reply).toHaveBeenCalled();
    expect(reply.mock.calls[0][0]).toContain("администраторам");
  });

  test("пустой allowlist запирает команды полностью", async () => {
    process.env.TELEGRAM_ADMIN_USER_IDS = "777";
    const { bot, handlers } = fakeBot();
    registerAdminCommands(bot as never, { resolveTg: () => undefined }, []);

    const { ctx, reply } = fakeCtx(ALLOWED_CHAT, 777, "/perms");
    await handlers.get("perms")!(ctx);

    expect(reply).not.toHaveBeenCalled();
  });
});

describe("ингест userbot'а fail-closed", () => {
  function ingest(allowed: Array<string | number>, chatId: string) {
    const seen: UserbotMessageEvent[] = [];
    const handler = makeHandler({
      onMessage: (m) => seen.push(m),
      allowedChatIds: allowed,
    });
    return handler({
      message: { chatId, id: 5, message: "привет", senderId: 42 },
    }).then(() => seen);
  }

  test("пустой allowlist не пропускает ничего", async () => {
    // До фикса тут была утечка личной переписки владельца в общую память
    // агентов: userbot работает от его настоящего аккаунта.
    expect(await ingest([], ALLOWED_CHAT)).toHaveLength(0);
  });

  test("чужой чат не пропускается", async () => {
    expect(await ingest([ALLOWED_CHAT], OUTSIDE_CHAT)).toHaveLength(0);
  });

  test("разрешённый чат по-прежнему проходит", async () => {
    const seen = await ingest([ALLOWED_CHAT], ALLOWED_CHAT);
    expect(seen).toHaveLength(1);
    expect(seen[0].text).toBe("привет");
  });

  test("gramjs без префикса -100 всё ещё матчится", async () => {
    // Ради этого и живёт нормализация — строгое равенство порвало бы прод.
    const seen = await ingest([ALLOWED_CHAT], "2000000001");
    expect(seen).toHaveLength(1);
  });
});
