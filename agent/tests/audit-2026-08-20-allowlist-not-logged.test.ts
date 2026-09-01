// Аудит 2026-08-20: отказ по allowlist печатал в лог ВЕСЬ allowlist.
//
//   orchestrator/voice-handler.ts:59
//     log.info(`[voice][${def.key}] chat ${chatId} not in allowlist ${allowed.join(",")}`)
//   orchestrator/message-handler.ts:203
//     log.info(`[raw][${def.key}] chat ${chatId} not in allowlist ${allowed.join(",")}`)
//
// Триггер недоверенный: строка пишется, когда апдейт пришёл из чата, которого
// в списке НЕТ. То есть любой, кто добавит роль-бота в свой чат и напишет
// туда, заставит бота выписать в journalctl полный список рабочих чатов
// команды — на каждое сообщение, на уровне info, то есть в проде.
//
// Рядом, в lib/admin-commands.ts:191, тот же отказ уже логируется правильно:
// назван только отвергнутый chat id, списка нет. Приводим две расходящиеся
// копии к этому образцу; `allowed.length` оставляем — он отличает «чата нет в
// списке» от «список пуст, конфиг не доехал», и сам по себе ничего не выдаёт.
import { describe, test, expect, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import type { Telegraf } from "telegraf";
import { registerVoiceHandler } from "../orchestrator/voice-handler.ts";
import { CHARACTERS } from "../characters/index.ts";
import type { RunningBot } from "../lib/types.ts";
import { log } from "../lib/log.ts";
import { cleanupChat } from "./_helpers.ts";

const ORCH = CHARACTERS.find((c) => c.key === "orchestrator")!;

/** Вызовы логгера целиком, включая многострочные. */
function logCalls(src: string): string[] {
  const out: string[] = [];
  const re = /log\.(?:info|warn|error|debug)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}

const FILES = [
  "../orchestrator/voice-handler.ts",
  "../orchestrator/message-handler.ts",
  "../lib/admin-commands.ts",
  "../lib/bot-error-guard.ts",
];

describe("аудит 2026-08-20: allowlist не печатается в лог", () => {
  for (const rel of FILES) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");

    test(`${rel}: список чатов не интерполируется в строку лога`, () => {
      // Отпечаток прежней формулировки — и любая другая развёртка массива.
      const bad = logCalls(src).filter((l) =>
        /\$\{[^}]*\b(allowed|allowedUserIds|allowlist)\b[^}]*\.(join|toString)\s*\(/.test(l) ||
        /\$\{[^}]*\.\.\.\s*(allowed|allowedUserIds)\b/.test(l),
      );
      expect(bad).toEqual([]);
    });
  }

  test("отказ по allowlist всё ещё логируется — строку не выкинули", () => {
    for (const rel of ["../orchestrator/voice-handler.ts", "../orchestrator/message-handler.ts"]) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      expect(logCalls(src).some((l) => /not in allowlist/.test(l))).toBe(true);
    }
  });
});

describe("строка отказа [voice] живьём", () => {
  const running: RunningBot = { def: ORCH, bot: {} as Telegraf, username: "lead_bot", id: 4242 };
  const CHAT = 999_314_010;
  // Соседи по allowlist — то, что не должно утечь вместе с отказом.
  const ALLOWED = ["-1001111111111", "-1002222222222", "-1003333333333"];
  const infoSpy = spyOn(log, "info");
  let lines: string[] = [];

  function handler(): (ctx: any) => Promise<void> {
    let captured: ((ctx: any) => Promise<void>) | undefined;
    const bot = {
      on: (event: string, fn: (ctx: any) => Promise<void>) => {
        if (event === "voice") captured = fn;
      },
    } as unknown as Telegraf;
    registerVoiceHandler(bot, ORCH, running, ALLOWED);
    return captured!;
  }

  beforeEach(() => {
    lines = [];
    infoSpy.mockImplementation(((msg: string) => {
      lines.push(msg);
    }) as any);
  });
  afterEach(() => cleanupChat(CHAT));
  afterAll(() => infoSpy.mockRestore());

  test("отказ называет только отвергнутый чат, но не соседей", async () => {
    await handler()({
      chat: { id: CHAT },
      from: { id: 123456789, username: "someone" },
      message: { voice: { file_id: "F" }, message_id: 1 },
      sendChatAction: async () => {},
      reply: async () => {},
    });

    const line = lines.find((l) => l.includes("not in allowlist"));
    expect(line).toBeDefined();
    expect(line).toContain(String(CHAT));
    for (const a of ALLOWED) expect(line).not.toContain(a);
  });
});
