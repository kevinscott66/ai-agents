/**
 * Аудит 2026-09-11, круг 26: внешний `catch` отвечал в чат мимо стоп-гейта.
 *
 * В `registerMessageHandler` (orchestrator/message-handler.ts) `try` открыт
 * ПЕРВОЙ строкой обработчика, а его `catch` извиняется перед человеком. Между
 * открытием `try` и гейтами стоит незащищённая запись входящего в короткую
 * память: `recordMessage` (lib/memory.ts) — голый `db.prepare().run()`, он
 * бросает синхронно на SQLITE_BUSY во время бэкапа, на readonly-базе, на
 * рассинхроне миграций. Порядок в коде — запись, «немой носитель», «нас не
 * упомянули», СТОП-ГЕЙТ, анти-дуп, лимит ingest.
 *
 * То есть ошибка, случившаяся раньше решения «отвечаем ли мы вообще»,
 * превращалась в ответ вместо этого решения. Поставленный на паузу агент
 * заговаривал — ровно то, что запрещает докблок гейта: «не должен ни
 * говорить, ни жечь на это токены». Дороже всего тут лимит ingest: у него
 * дроп ТИХИЙ и в коде подписано почему — «no reply — avoids an amplifiable
 * bounce». При бросающей записи каждый флудящий апдейт получал ответ, то есть
 * усилитель включался именно в том месте, где его выключали.
 *
 * Голосовой путь той же ошибки не делает: там `recordMessage` стоит ПОСЛЕ
 * всех трёх гейтов (orchestrator/voice-handler.ts).
 *
 * Черта проведена флагом `turnStarted`: он поднимается один раз, когда гейты
 * позади и ход начат. Сбой до черты — лог и молчание; после — извинение, как
 * и завёл аудит 2026-08-21. Проверяется и то и другое: тест, который смотрит
 * только на молчание, зеленеет и от `catch`, выброшенного целиком.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { registerMessageHandler } from "../orchestrator/message-handler.ts";
import { CHARACTERS } from "../characters/index.ts";
import { db } from "../lib/db.ts";

const SRC = readFileSync(
  join(import.meta.dir, "..", "orchestrator", "message-handler.ts"),
  "utf8",
);

const CHAT = -1009266;
const CHAT_S = String(CHAT);
const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;

let nextMessageId = 6001;

function setPaused(paused: 0 | 1) {
  db.prepare(
    `INSERT INTO agent_states(agent_key, paused, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(agent_key) DO UPDATE SET
       paused = excluded.paused, updated_at = excluded.updated_at`,
  ).run(ORCH.key, paused, Date.now());
}

beforeEach(() => {
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT_S);
  db.prepare(`DELETE FROM processed_triggers WHERE chat_id = ?`).run(CHAT_S);
});

afterEach(() => {
  db.exec("PRAGMA query_only = 0");
  db.prepare(`DELETE FROM agent_states WHERE agent_key = ?`).run(ORCH.key);
  db.prepare(`DELETE FROM messages WHERE chat_id = ?`).run(CHAT_S);
  db.prepare(`DELETE FROM processed_triggers WHERE chat_id = ?`).run(CHAT_S);
});

/**
 * Прогнать апдейт через настоящий обработчик и вернуть то, что ушло в чат.
 *
 * `llmFails` подменяет источник сбоя: при `false` падает запись в память (до
 * гейтов), при `true` — сам ход модели (после них).
 */
async function deliver(opts: { llmFails: boolean }): Promise<string[]> {
  let handler: ((ctx: any) => Promise<void>) | null = null;
  const replies: string[] = [];

  const anthropic = {
    messages: {
      create: async () => {
        if (opts.llmFails) throw new Error("upstream 500");
        return {
          id: "m",
          type: "message",
          role: "assistant",
          model: "t",
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
          content: [{ type: "text", text: "ок" }],
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;

  const lead: any = {
    on: (_ev: string, h: any) => {
      handler = h;
    },
    telegram: { sendChatAction: async () => {} },
  };
  const running: any = { def: ORCH, bot: lead, username: "delabs_lead_bot", id: 41 };

  registerMessageHandler(lead, ORCH, running, {
    bots: [running],
    allowed: [CHAT_S],
    historyLimit: 30,
    anthropic,
    model: "test-model",
    handoffDeps: {
      anthropic,
      model: "test-model",
      historyLimit: 30,
      bots: [running],
    } as any,
    respondAsImpl: (async () => null) as never,
  });

  await handler!({
    chat: { id: CHAT },
    from: { id: 778, username: "petya", is_bot: false },
    message: { message_id: nextMessageId++, text: "@delabs_lead_bot привет" },
    sendChatAction: async () => {},
    reply: async (t: string) => {
      replies.push(t);
      return { message_id: 9100, date: Math.floor(Date.now() / 1000) };
    },
  });

  return replies;
}

describe("сбой до гейтов не превращается в реплику", () => {
  test("агент на паузе молчит и тогда, когда падает запись в память", async () => {
    setPaused(1);
    // Ровно тот отказ, что называет докблок: база стала недоступна для
    // записи, и первым об это спотыкается `recordMessage` — выше гейта.
    db.exec("PRAGMA query_only = 1");
    expect(await deliver({ llmFails: false })).toEqual([]);
  });

  test("и не на паузе тоже: решение «наш ли это ход» ещё не принято", async () => {
    // Без паузы ход законен, но сбой всё равно случился ДО анти-дупа и лимита
    // ingest. Ответ здесь — это ответ на апдейт, который мог быть и дублем, и
    // сверхлимитным: оба обязаны уходить молча.
    db.exec("PRAGMA query_only = 1");
    expect(await deliver({ llmFails: false })).toEqual([]);
  });

  test("сбой ПОСЛЕ черты по-прежнему объясняют человеку", async () => {
    const replies = await deliver({ llmFails: true });
    expect(replies).toHaveLength(1);
    expect(replies[0].length).toBeGreaterThan(0);
    // И не пересказывая причину: правило аудита 2026-08-28.
    expect(replies[0]).not.toContain("upstream 500");
  });
});

describe("черта стоит там, где решение уже принято", () => {
  test("флаг поднимается после лимита ingest, а не до него", () => {
    const gate = SRC.indexOf("checkAndConsumeIngestLimit(chatId");
    const mark = SRC.indexOf("turnStarted = true");
    expect(gate).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(gate);
  });

  test("catch проверяет флаг прежде, чем отвечать", () => {
    const check = SRC.indexOf("if (!turnStarted) return;");
    const reply = SRC.indexOf("replyForTurnError(err)");
    expect(check).toBeGreaterThan(-1);
    expect(reply).toBeGreaterThan(check);
  });
});
