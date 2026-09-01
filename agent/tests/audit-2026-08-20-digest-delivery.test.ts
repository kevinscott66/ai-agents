/**
 * Аудит 2026-08-20 — полный провал доставки дайджеста выглядел как успех.
 *
 * Маркер «сегодня постили» пишется ДО рассылки — сознательно (иначе упавший на
 * полпути отправитель превращается в бесконечный ретрай, аудит 2026-08-08 про
 * 216 копий в чат). Но дальше каждый `sendMessage` заворачивался в `log.warn`,
 * и `post()` возвращал `true` независимо от того, дошло ли хоть что-нибудь.
 *
 * Итог: день закрыт, повтора не будет, а единственный след пропажи — warn'ы
 * вперемешку с остальным журналом. Дайджест исчезает на сутки молча.
 *
 * Чинится не отменой раннего маркера (он прав), а честностью: ноль доставок —
 * это `log.error` и `false`, частичная доставка — сводка.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDigestScheduler } from "../lib/digest.ts";

const AT_6AM = () => new Date("2026-05-21T06:05:00Z");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function markerPath(): string {
  const root = mkdtempSync(join(tmpdir(), "digest-deliv-"));
  dirs.push(root);
  return join(root, ".digest-last");
}

function scheduler(chatIds: string[], send: (chatId: string | number) => Promise<unknown>) {
  return startDigestScheduler({
    sender: { sendMessage: (chatId) => send(chatId) },
    chatIds,
    intervalMs: 3_600_000,
    markerPath: markerPath(),
    nowProvider: AT_6AM,
  });
}

describe("дайджест: доставка", () => {
  test("все чаты упали — false, а не тихий успех", async () => {
    const tried: Array<string | number> = [];
    const h = scheduler(["-100111", "-100222"], async (c) => {
      tried.push(c);
      throw new Error("bot was blocked by the user");
    });
    try {
      expect(await h._runNow()).toBe(false);
      // Попытка была во ВСЕ чаты: первый отказ не обрывает рассылку.
      expect(tried).toEqual(["-100111", "-100222"]);
    } finally {
      h.stop();
    }
  });

  test("день всё равно закрыт — ретрая быть не должно", async () => {
    let calls = 0;
    const h = scheduler(["-100111"], async () => {
      calls++;
      throw new Error("timeout");
    });
    try {
      expect(await h._runNow()).toBe(false);
      expect(await h._runNow()).toBe(false);
      expect(await h._runNow()).toBe(false);
      // Один заход: маркер стоит, повторных рассылок нет (аудит 2026-08-08).
      expect(calls).toBe(1);
    } finally {
      h.stop();
    }
  });

  test("хотя бы один чат получил — это успех", async () => {
    const h = scheduler(["-100111", "-100222"], async (c) => {
      if (c === "-100111") throw new Error("chat not found");
      return { ok: true };
    });
    try {
      expect(await h._runNow()).toBe(true);
    } finally {
      h.stop();
    }
  });

  test("все чаты получили — успех, как и раньше", async () => {
    const got: Array<string | number> = [];
    const h = scheduler(["-100111", "-100222"], async (c) => {
      got.push(c);
      return { ok: true };
    });
    try {
      expect(await h._runNow()).toBe(true);
      expect(got).toHaveLength(2);
    } finally {
      h.stop();
    }
  });

  test("пустой список чатов — не успех: дайджест ушёл в никуда", async () => {
    const h = scheduler([], async () => ({ ok: true }));
    try {
      expect(await h._runNow()).toBe(false);
    } finally {
      h.stop();
    }
  });
});
