/**
 * Аудит 2026-08-29: действие уходило наружу раньше, чем о нём появлялась запись.
 *
 * `dispatchAndAudit` писал в `agent_actions` ровно одну строку и делал это
 * ПОСЛЕ `await dispatchAction`. Смерть процесса в промежутке — деплойный
 * рестарт, OOM, `systemctl restart` — оставляла отправленное сообщение вовсе
 * без следа: ни в ленте Mini App, ни в GET_LOGS, ни в `/audit`. Разбирать
 * такой случай постфактум было не по чему, а единственная запись о нём
 * (log.info) уезжает с ротацией.
 *
 * Здесь проверяется новая раскладка: строка `attempted` заводится ДО вызова и
 * закрывается терминальным статусом после (`finalizeActionRow`), санитар
 * db-maint подбирает те, за которыми никто не вернулся, а число строк на одно
 * действие не изменилось — их по-прежнему одна.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __setDispatchAuditFaultForTests,
  gateOrDispatch,
} from "../lib/action-dispatch.ts";
import { finalizeActionRow, insertActionRow } from "../lib/audit.ts";
import { expireStaleAttempts } from "../lib/db-maint.ts";
import { db } from "../lib/db.ts";
import { subscribe } from "../lib/events-bus.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { setAutonomy } from "../lib/permissions.ts";
import { cleanupChat, restoreAutonomy, saveAutonomy } from "./_helpers.ts";

const CHAT = -1_000_991;
const AGENT = "orchestrator";

let previousAutonomy = saveAutonomy();

interface Row {
  id: string;
  status: string;
  payload: string | null;
  result: string | null;
  error: string | null;
  created_at: number;
}

function rows(): Row[] {
  return db
    .prepare(
      `SELECT id, status, payload, result, error, created_at FROM agent_actions
       WHERE chat_id = ? ORDER BY created_at, id`,
    )
    .all(CHAT) as Row[];
}

/** Telegram-заглушка, которая заодно смотрит в базу в момент отправки. */
function watchingTelegram(seen: Row[][]) {
  return {
    sendMessage: async (_chatId: number, _text: string) => {
      seen.push(rows());
      return { message_id: seen.length, date: Math.floor(Date.now() / 1000) };
    },
  } as never;
}

beforeEach(() => {
  previousAutonomy = saveAutonomy();
  setAutonomy("global", "*", "auto");
  _resetRateLimits();
  __setDispatchAuditFaultForTests(null);
  cleanupChat(CHAT, AGENT);
});

afterEach(() => {
  __setDispatchAuditFaultForTests(null);
  _resetRateLimits();
  cleanupChat(CHAT, AGENT);
  restoreAutonomy(previousAutonomy);
});

describe("строка действия существует раньше последствия", () => {
  test("в момент отправки запись уже есть, и в ней лежит то, что отправляется", async () => {
    const seen: Row[][] = [];
    const res = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "письмо, которое переживёт падение" },
      { agentKey: AGENT, chatId: CHAT, telegram: watchingTelegram(seen) },
    );
    expect(res.kind).toBe("ok");

    // Ровно этого не было до аудита: на момент обращения к Telegram в базе не
    // лежало ничего.
    expect(seen).toHaveLength(1);
    const during = seen[0]!;
    expect(during).toHaveLength(1);
    expect(during[0]!.status).toBe("attempted");
    expect(during[0]!.payload).toContain("переживёт падение");
  });

  test("результат дописывается в ту же строку — их по-прежнему одна", async () => {
    const seen: Row[][] = [];
    await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "одна строка на действие" },
      { agentKey: AGENT, chatId: CHAT, telegram: watchingTelegram(seen) },
    );
    const after = rows();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(seen[0]![0]!.id);
    expect(after[0]!.status).toBe("ok");
    // Начало действия, а не конец: для долгих действий это единственная честная
    // отметка старта.
    expect(after[0]!.created_at).toBe(seen[0]![0]!.created_at);
  });

  test("событие ленты поднимается один раз и только на завершении", async () => {
    const events: Array<{ name: string; status: unknown }> = [];
    const off = subscribe((e) => {
      const p = e.payload as { id?: string; status?: unknown } | undefined;
      if (e.name === "action.executed") events.push({ name: e.name, status: p?.status });
    });
    try {
      const seenCounts: number[] = [];
      await gateOrDispatch(
        "SEND_MESSAGE",
        { text: "событие только на финише" },
        {
          agentKey: AGENT,
          chatId: CHAT,
          telegram: {
            sendMessage: async () => {
              // Подписчик, разбуженный на `attempted`, показал бы завершённым
              // действие, которое ещё идёт.
              seenCounts.push(events.length);
              return { message_id: 1, date: 0 };
            },
          } as never,
        },
      );
      expect(seenCounts).toEqual([0]);
      expect(events).toEqual([{ name: "action.executed", status: "ok" }]);
    } finally {
      off();
    }
  });

  test("отказ записи «в полёте» не отменяет действие", async () => {
    const sent: string[] = [];
    __setDispatchAuditFaultForTests((phase) => {
      if (phase === "inflight") {
        __setDispatchAuditFaultForTests(null);
        throw new Error("in-flight insert unavailable");
      }
    });
    const res = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "аудит не условие исполнения" },
      {
        agentKey: AGENT,
        chatId: CHAT,
        telegram: {
          sendMessage: async (_c: number, text: string) => {
            sent.push(text);
            return { message_id: 1, date: 0 };
          },
        } as never,
      },
    );
    expect(res.kind).toBe("ok");
    expect(sent).toHaveLength(1);
    // Откат к прежнему поведению: одна строка, записанная после факта.
    const after = rows();
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("ok");
  });

  test("сорванное закрытие дописывает ту же строку, а не заводит вторую", async () => {
    const sent: string[] = [];
    __setDispatchAuditFaultForTests((phase) => {
      if (phase === "primary") {
        __setDispatchAuditFaultForTests(null);
        throw new Error("primary close unavailable");
      }
    });
    const before = rows();
    const res = await gateOrDispatch(
      "SEND_MESSAGE",
      { text: "закрытие сорвалось" },
      {
        agentKey: AGENT,
        chatId: CHAT,
        telegram: {
          sendMessage: async (_c: number, text: string) => {
            sent.push(text);
            return { message_id: 1, date: 0 };
          },
        } as never,
      },
    );
    expect(sent).toHaveLength(1);
    expect(res.kind).toBe("error");
    // Действие одно — и запись о нём одна. Аварийный путь дописывает строку в
    // полёте, а не кладёт рядом вторую: иначе любой счёт по `agent_actions`
    // завышал бы ровно в те моменты, когда база и так нездорова.
    const after = rows();
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)!.status).toBe("error");
    expect(after.at(-1)!.error).toContain("primary close unavailable");
  });
});

describe("уже записанный результат не переписывает никто", () => {
  test("закрыть можно только строку в полёте", () => {
    const open = insertActionRow("SEND_MESSAGE", {
      agentKey: AGENT,
      chatId: CHAT,
      status: "attempted",
    });
    expect(finalizeActionRow(open.id, { status: "ok", result: { n: 1 } })).not.toBeNull();
    // Повтор — уже по терминальной строке.
    expect(finalizeActionRow(open.id, { status: "error", error: "поздно" })).toBeNull();
    const after = rows();
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("ok");
    expect(after[0]!.error).toBeNull();
  });

  test("нетерминальный статус в закрытии — это ошибка вызывающего", () => {
    const open = insertActionRow("SEND_MESSAGE", {
      agentKey: AGENT,
      chatId: CHAT,
      status: "attempted",
    });
    expect(() => finalizeActionRow(open.id, { status: "attempted" })).toThrow(
      /нетерминальный статус/,
    );
  });
});

describe("санитар подбирает брошенные строки", () => {
  function seed(status: "attempted" | "ok", ageMs: number): string {
    const { id } = insertActionRow("SEND_MESSAGE", {
      agentKey: AGENT,
      chatId: CHAT,
      status,
    });
    db.prepare(`UPDATE agent_actions SET created_at = ? WHERE id = ?`).run(
      Date.now() - ageMs,
      id,
    );
    return id;
  }

  test("старая строка в полёте закрывается ошибкой, свежая — нет", () => {
    const stale = seed("attempted", 8 * 60 * 60_000);
    const fresh = seed("attempted", 60_000);

    const res = expireStaleAttempts({ ttlMs: 6 * 60 * 60_000 });
    expect(res.expired).toBe(1);

    const byId = new Map(rows().map((r) => [r.id, r]));
    expect(byId.get(stale)!.status).toBe("error");
    expect(byId.get(stale)!.error).toContain("результат не был записан");
    // Свежая может быть настоящей длинной сессией — трогать её нельзя.
    expect(byId.get(fresh)!.status).toBe("attempted");
  });

  test("терминальную строку возраст не делает брошенной", () => {
    const old = seed("ok", 30 * 24 * 60 * 60_000);
    expect(expireStaleAttempts({ ttlMs: 60_000 }).expired).toBe(0);
    expect(rows().find((r) => r.id === old)!.status).toBe("ok");
  });

  test("закрытие санитаром доезжает до ленты", () => {
    const events: unknown[] = [];
    const off = subscribe((e) => {
      if (e.name === "action.executed") events.push(e.payload);
    });
    try {
      seed("attempted", 8 * 60 * 60_000);
      expect(expireStaleAttempts({ ttlMs: 6 * 60 * 60_000 }).expired).toBe(1);
      expect(events).toHaveLength(1);
      expect((events[0] as { status: string }).status).toBe("error");
    } finally {
      off();
    }
  });
});
