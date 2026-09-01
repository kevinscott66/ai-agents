/**
 * Аудит 2026-08-20: SIGTERM проглатывался целиком, если хотя бы один бот не
 * успел поднять поллинг.
 *
 * telegraf бросает `Bot is not running!` из stop(), когда polling === undefined
 * (проверено на telegraf@4.16.3). Попасть в это окно легко: launch падает на
 * deleteWebhook ДО startPolling, и launchWithRestart ходит по три секунды,
 * пока не пройдёт. Исключение из `for (const b of bots) b.bot.stop(sig)`
 * вылетало из слушателя сигнала: process.exit(0) не выполнялся, остальные боты
 * не останавливались, а uncaughtException-хендлер только логирует и
 * возвращается. systemd ждал TimeoutStopSec и бил SIGKILL, а старый инстанс
 * всё это время конкурировал с новым за getUpdates.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { stopAllSafely, type StoppableBot } from "../lib/launch-restart.ts";

function bot(key: string, onStop: () => void): StoppableBot {
  return { def: { key }, bot: { stop: onStop } };
}

function throwingBot(key: string, msg = "Bot is not running!"): StoppableBot {
  return {
    def: { key },
    bot: {
      stop: () => {
        throw new Error(msg);
      },
    },
  };
}

describe("stopAllSafely", () => {
  it("бросивший бот не мешает остановить следующих", () => {
    const stopped: string[] = [];
    const failed = stopAllSafely(
      [
        bot("orchestrator", () => stopped.push("orchestrator")),
        throwingBot("smm"),
        bot("qa", () => stopped.push("qa")),
        bot("design", () => stopped.push("design")),
      ],
      "SIGTERM",
    );
    expect(stopped).toEqual(["orchestrator", "qa", "design"]);
    expect(failed).toBe(1);
  });

  it("падение первого не отменяет остальных", () => {
    const stopped: string[] = [];
    const failed = stopAllSafely(
      [throwingBot("a"), bot("b", () => stopped.push("b"))],
      "SIGTERM",
    );
    expect(stopped).toEqual(["b"]);
    expect(failed).toBe(1);
  });

  it("возвращает число упавших, а не бросает", () => {
    expect(() =>
      stopAllSafely([throwingBot("a"), throwingBot("b")], "SIGTERM"),
    ).not.toThrow();
    expect(stopAllSafely([throwingBot("a"), throwingBot("b")], "SIGINT")).toBe(2);
  });

  it("когда все живы — ноль упавших и все остановлены", () => {
    const stopped: string[] = [];
    const failed = stopAllSafely(
      [bot("a", () => stopped.push("a")), bot("b", () => stopped.push("b"))],
      "SIGTERM",
    );
    expect(failed).toBe(0);
    expect(stopped).toEqual(["a", "b"]);
  });

  it("пустой список — ноль, без падений", () => {
    expect(stopAllSafely([], "SIGTERM")).toBe(0);
  });

  it("сигнал доезжает до бота как есть", () => {
    const seen: (string | undefined)[] = [];
    stopAllSafely([{ def: { key: "a" }, bot: { stop: (s) => seen.push(s) } }], "SIGINT");
    expect(seen).toEqual(["SIGINT"]);
  });

  it("не-Error тоже переживается", () => {
    const stopped: string[] = [];
    const failed = stopAllSafely(
      [
        {
          def: { key: "a" },
          bot: {
            stop: () => {
              throw "строка вместо Error";
            },
          },
        },
        bot("b", () => stopped.push("b")),
      ],
      "SIGTERM",
    );
    expect(failed).toBe(1);
    expect(stopped).toEqual(["b"]);
  });
});

describe("вызов из orchestrator-team.ts закреплён", () => {
  const SRC = readFileSync(
    new URL("../orchestrator-team.ts", import.meta.url),
    "utf8",
  );

  it("голого цикла b.bot.stop(sig) больше нет", () => {
    expect(SRC).not.toMatch(/for \(const b of bots\) b\.bot\.stop\(/);
  });

  it("остановка идёт через stopAllSafely", () => {
    expect(SRC).toMatch(/stopAllSafely\(bots, sig\)/);
  });

  it("services.stop() обёрнут в try — он тоже в слушателе сигнала", () => {
    expect(SRC).toMatch(/try \{\s*services\.stop\(\);\s*\} catch/);
  });

  it("process.exit(0) стоит последним, после остановки ботов", () => {
    const stopBody = SRC.slice(
      SRC.indexOf("const stop = (sig: string)"),
      SRC.indexOf('process.once("SIGINT"'),
    );
    // Ищем именно оператор (строка, начинающаяся с отступа), а не упоминание
    // process.exit(0) в комментарии выше — оно там есть по делу.
    const exitAt = stopBody.search(/^\s+process\.exit\(0\);$/m);
    expect(exitAt).toBeGreaterThan(-1);
    expect(stopBody.indexOf("stopAllSafely")).toBeLessThan(exitAt);
  });
});
