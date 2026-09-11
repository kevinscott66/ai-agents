/**
 * Аудит 2026-09-11: обещание «every 10s» у прогресса MAC_RUN_CLAUDE.
 *
 * Комментарий у `onProgress` в lib/dispatch/mac.ts читался как heartbeat:
 * пока прогон жив, раз в десять секунд приходит строка. На деле условие
 * двойное — `now - lastNoticeAt >= 10_000 && totalLen > lastLen`, — и второй
 * половины в обещании не было. Прогон, который десять минут молча собирает
 * проект или ждёт сети, не шлёт в чат ни строки.
 *
 * Вред не в коде, а в выводе, который делает по нему человек: «сообщений нет
 * десять минут» при таком комментарии читается как «прогон умер», и дальше
 * идёт MAC_STOP с повторным запуском — ровно тот сценарий, от которого
 * `macFailureLeavesRunAlive` в том же файле защищает отдельным текстом.
 *
 * Тест держит ПОВЕДЕНИЕ, а не формулировку: молчащий прогон молчит, растущий —
 * говорит, и не чаще раза в десять секунд.
 */
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import { handleMacRunClaude, type MacBridge } from "../lib/dispatch/mac.ts";

afterEach(() => {
  setSystemTime();
});

const PAYLOAD = {
  project: "/tmp/x",
  prompt: "hi",
  mode: "ask" as const,
  _userId: "42",
};

function fakeTg() {
  const sent: string[] = [];
  return {
    sent,
    tg: {
      sendMessage: async (_chatId: unknown, text: string) => {
        sent.push(String(text));
        return { message_id: sent.length };
      },
    },
  };
}

/**
 * Заглушка демона: дёргает onProgress по заданному сценарию, каждый раз
 * сдвигая часы. `len` — сколько всего вывода накопилось к этому моменту.
 */
function bridgeDriving(steps: { advanceMs: number; len: number }[]): MacBridge {
  return {
    isMacConnected: () => true,
    isMacOnline: () => true,
    stopMac: async () => ({ ok: true }),
    isUserAllowed: () => true,
    sendToMac: async (req) => {
      for (const s of steps) {
        setSystemTime(new Date(Date.now() + s.advanceMs));
        req.onProgress?.({ stdout: "", stderr: "", stdoutLen: s.len, stderrLen: 0 });
      }
      return { ok: true, code: 0, stdout: "done", stderr: "" };
    },
  } as MacBridge;
}

/** Строки прогресса среди всего, что ушло в чат. */
const progressLines = (sent: string[]) => sent.filter((t) => t.includes("[mac] running…"));

describe("прогресс MAC_RUN_CLAUDE — не heartbeat", () => {
  test("время идёт, вывод не растёт — в чат не уходит ничего", async () => {
    setSystemTime(new Date("2026-09-11T10:00:00Z"));
    const { tg, sent } = fakeTg();
    const res = await handleMacRunClaude(PAYLOAD as any, {
      agentKey: "backend",
      chatId: -1,
      telegram: tg as any,
      // Пять минут тишины: онпрогресс зовётся, но длина стоит на месте.
      macBridge: bridgeDriving(
        Array.from({ length: 30 }, () => ({ advanceMs: 10_000, len: 0 })),
      ),
    });
    expect(res.ok).toBe(true);
    expect(progressLines(sent).length).toBe(0);
  });

  test("вывод растёт — строка уходит, но не чаще раза в десять секунд", async () => {
    setSystemTime(new Date("2026-09-11T10:00:00Z"));
    const { tg, sent } = fakeTg();
    // Двадцать шагов по секунде, вывод растёт на каждом: пройдено 20 секунд,
    // значит окон ровно два.
    const res = await handleMacRunClaude(PAYLOAD as any, {
      agentKey: "backend",
      chatId: -1,
      telegram: tg as any,
      macBridge: bridgeDriving(
        Array.from({ length: 20 }, (_, i) => ({ advanceMs: 1_000, len: (i + 1) * 100 })),
      ),
    });
    expect(res.ok).toBe(true);
    expect(progressLines(sent).length).toBe(2);
  });

  test("обещание в комментарии совпадает с этим поведением", async () => {
    const SRC = await Bun.file(
      new URL("../lib/dispatch/mac.ts", import.meta.url),
    ).text();
    const at = SRC.indexOf("let lastNoticeAt");
    expect(at).toBeGreaterThan(-1);
    const note = SRC.slice(Math.max(0, at - 800), at)
      .replace(/\n\s*\/\/ ?/g, " ")
      .replace(/\s+/g, " ");
    expect(note).not.toContain("Periodic system progress updates every 10s");
    expect(note).toContain("НЕ heartbeat");
  });
});
