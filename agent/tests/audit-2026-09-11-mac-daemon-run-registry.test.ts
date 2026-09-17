/**
 * Аудит 2026-09-11, круг 30: две дыры на входе в прогон Mac-демона.
 *
 * 1. `activeChildren.set(id, child)` без проверки. Карта — единственная дорога
 *    до запущенного `claude`: `cancelRun` ищет по id, `killAll` ходит по
 *    значениям, уборка при закрытии сокета — тоже через неё. Второй `run` с
 *    тем же id не «обновлял запись», а вытеснял первый процесс из карты: он
 *    остаётся жить на маке владельца, в режиме `bypass` выполняя команды без
 *    спроса, и его больше не достанет ни точечная отмена, ни кадр `stop`, ни
 *    закрытие сокета. Круг 2026-08-13 закрыл ровно этот класс для таймаута —
 *    и он же вернулся через повтор id.
 *
 * 2. Ошибка записи промпта в stdin только печаталась в консоль, а выполнение
 *    шло дальше — на `await child.exited`. `claude --print` без промпта сам не
 *    выходит, поэтому прогон висел до `RUN_TIMEOUT_MS` моста и владелец
 *    получал `mac_timeout` — ответ, в котором о настоящей причине нет ни
 *    слова: она осталась строкой в локальном логе демона.
 *
 * Проверяется не исходником, а поведением: обе развилки вынесены в
 * `mac-daemon/kill.ts` и `mac-daemon/run-io.ts` — файлы без побочных
 * эффектов, в отличие от самого `daemon.ts`, который на импорте читает env и
 * лезет в сеть.
 */
import { describe, expect, test } from "bun:test";
import { cancelRun, killAll, registerChild, type KillableChild } from "../mac-daemon/kill.ts";
import { feedPrompt } from "../mac-daemon/run-io.ts";

/** Поддельный ребёнок: помнит полученные сигналы, «выходит» сразу. */
function fakeChild(): KillableChild & { signals: string[] } {
  const signals: string[] = [];
  return {
    signals,
    kill(sig?: number | NodeJS.Signals) {
      signals.push(String(sig ?? "SIGTERM"));
    },
    exited: Promise.resolve(0),
  };
}

describe("id прогона занимается, а не перезаписывается", () => {
  test("первый занявший id остаётся в карте, второй получает отказ", () => {
    const map = new Map<string, KillableChild>();
    const first = fakeChild();
    const second = fakeChild();

    expect(registerChild(map, "run-1", first)).toBe(true);
    expect(registerChild(map, "run-1", second)).toBe(false);
    expect(map.get("run-1")).toBe(first);
    expect(map.size).toBe(1);
  });

  test("после отказа отмена по id достаёт ПЕРВЫЙ процесс", () => {
    const map = new Map<string, KillableChild>();
    const first = fakeChild();
    const second = fakeChild();
    registerChild(map, "run-1", first);
    registerChild(map, "run-1", second);

    expect(cancelRun(map, "run-1")).toBe(true);

    expect(first.signals).toContain("SIGINT");
    expect(second.signals).toEqual([]);
  });

  test("различающее свидетельство: прежняя форма теряла первый процесс", () => {
    // Ровно то, что стояло в daemon.ts до правки. Тест обязан показывать не
    // «новая функция работает», а чем именно она отличается от старой строки.
    const map = new Map<string, KillableChild>();
    const first = fakeChild();
    const second = fakeChild();

    map.set("run-1", first);
    map.set("run-1", second);

    // Первый процесс жив, но недостижим: ни отмена, ни общий kill его не видят.
    expect(cancelRun(map, "run-1")).toBe(true);
    expect(first.signals).toEqual([]);
    expect(killAll(map)).toBe(0);
    expect(first.signals).toEqual([]);
  });

  test("разные id живут рядом и оба доступны", () => {
    const map = new Map<string, KillableChild>();
    const a = fakeChild();
    const b = fakeChild();
    expect(registerChild(map, "a", a)).toBe(true);
    expect(registerChild(map, "b", b)).toBe(true);

    expect(killAll(map)).toBe(2);
    expect(a.signals).toContain("SIGINT");
    expect(b.signals).toContain("SIGINT");
  });

  test("освобождённый id можно занять снова", () => {
    const map = new Map<string, KillableChild>();
    const first = fakeChild();
    registerChild(map, "run-1", first);
    cancelRun(map, "run-1");

    expect(registerChild(map, "run-1", fakeChild())).toBe(true);
  });
});

describe("отказ записи промпта — отказ прогона", () => {
  test("промпт доезжает до stdin в форме write/end", async () => {
    const chunks: Uint8Array[] = [];
    let ended = false;
    const child = {
      stdin: {
        write: (c: Uint8Array) => chunks.push(c),
        end: () => {
          ended = true;
        },
      },
    };

    expect(await feedPrompt(child, "привет")).toEqual({ ok: true });
    expect(new TextDecoder().decode(chunks[0])).toBe("привет");
    expect(ended).toBe(true);
  });

  test("вторая форма — writer с write/close", async () => {
    const chunks: Uint8Array[] = [];
    let closed = false;
    const child = {
      stdin: {
        write: async (c: Uint8Array) => {
          chunks.push(c);
        },
        close: async () => {
          closed = true;
        },
      },
    };

    expect(await feedPrompt(child, "x")).toEqual({ ok: true });
    expect(new TextDecoder().decode(chunks[0])).toBe("x");
    expect(closed).toBe(true);
  });

  test("сломанный stdin возвращает отказ, а не проглатывается", async () => {
    const child = {
      stdin: {
        write: () => {
          throw new Error("EPIPE");
        },
        end: () => {},
      },
    };

    const r = await feedPrompt(child, "промпт");

    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/^stdin_write_failed: /);
    // Причина доезжает до моста, а не остаётся в локальном логе демона.
    expect((r as { error: string }).error).toContain("EPIPE");
  });

  test("отказ на закрытии stdin тоже отказ, а не успех", async () => {
    const child = {
      stdin: {
        write: () => {},
        end: () => {
          throw new Error("closed twice");
        },
      },
    };

    expect((await feedPrompt(child, "p")).ok).toBe(false);
  });

  test("feedPrompt не бросает — решение принимает вызывающий", async () => {
    // Бросок вернул бы нас к `try/catch` вокруг вызова, то есть к той же
    // развилке «поймал и пошёл дальше», ради которой всё и затевалось.
    const child = { stdin: null };
    const r = await feedPrompt(child, "p");
    expect(r.ok).toBe(false);
  });
});
