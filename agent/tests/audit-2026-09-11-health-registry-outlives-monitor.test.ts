/**
 * Аудит 2026-09-11: остановка health-монитора не возвращала систему в «о
 * здоровье ничего не известно», а навсегда фиксировала худший из виденных
 * снимков.
 *
 * `HEALTH_REGISTRY` (lib/health.ts) — процессная карта, из которой
 * `isAgentAvailable` (lib/role-skills.ts) берёт здоровье роли. Её fail-open
 * стоит РОВНО на отсутствии записи: «No health info → treat as available
 * (monitor may not be running)». Но `stop()` гасил только таймер, а запись
 * оставлял — с последним `alive: false` и накопленным `consecutiveFailures`.
 * Монитора, который мог бы это опровергнуть, после `stop()` уже нет, поэтому
 * запись становилась неопровержимой: делегирование в роль уходило в фолбэк
 * навсегда, и восстановление бота ничего не меняло.
 *
 * Замер до правки: три неудачных тика по ключу `backend`, затем `stop()` —
 * `isAgentAvailable("backend") === false`, `pickAvailableAgent("backend")`
 * отдаёт `{role: "tgdev", reroutedFrom: "backend"}`. Порог у проверки
 * `consecutiveFailures > 2`, то есть трёх отказов подряд достаточно.
 *
 * Второй адресат — изоляция прогона: `bun test` гоняет все файлы в одном
 * процессе, а хука сброса у этой карты не было (у такой же модульной карты в
 * watchdog.ts он есть — `_resetWatchdogState`). Сегодня межфайловая утечка не
 * стреляет по совпадению: файлы с падающим ботом берут синтетические ключи, а
 * единственный настоящий (`orchestrator` в health-error-token-leak) набирает
 * ровно один отказ на свежем мониторе. Один лишний `_tick()` в той фикстуре
 * сделал бы `pickAvailableAgent` в любом последующем файле зависящим от
 * порядка прогона — то есть ровно тот дефект, ради которого заведена эта
 * ветка.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import {
  startHealthMonitor,
  getHealthSnapshot,
  _resetHealthRegistry,
} from "../lib/health.ts";
import { isAgentAvailable, pickAvailableAgent } from "../lib/role-skills.ts";
import type { RunningBot } from "../lib/types.ts";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url).pathname, "utf8");

const makeBot = (key: string, getMe: () => Promise<unknown>): RunningBot =>
  ({
    id: 1,
    username: key + "_bot",
    def: { key },
    bot: { telegram: { getMe } },
  }) as unknown as RunningBot;

const dead = (key: string) => makeBot(key, async () => { throw new Error("boom"); });
const live = (key: string) => makeBot(key, async () => ({ id: 1, username: key }));

/** Монитор, отработавший `ticks` тиков и остановленный. */
async function runAndStop(bots: RunningBot[], ticks: number): Promise<void> {
  const h = startHealthMonitor({ bots, intervalMs: 60_000 });
  try {
    for (let i = 0; i < ticks; i++) await h._tick();
  } finally {
    h.stop();
  }
}

// Реестр процессный: если правка когда-нибудь отъедет, этот файл не должен
// портить соседям прогон — именно тем способом, который тут и разбирается.
afterEach(() => _resetHealthRegistry());

describe("реестр здоровья не переживает свой монитор", () => {
  test("после stop() о ботах монитора снова ничего не известно", async () => {
    await runAndStop([dead("backend")], 3);
    expect(getHealthSnapshot("backend")).toBeUndefined();
  });

  test("делегирование возвращается к цели, а не залипает в фолбэке", async () => {
    await runAndStop([dead("backend")], 3);
    // До правки: false и {role: "tgdev", reroutedFrom: "backend"} навсегда.
    expect(isAgentAvailable("backend")).toBe(true);
    const picked = pickAvailableAgent("backend");
    expect(picked?.role).toBe("backend");
    expect(picked?.reroutedFrom).toBeUndefined();
  });

  test("пока монитор жив, отказы видны — фолбэк работает как задуман", async () => {
    const h = startHealthMonitor({ bots: [dead("backend")], intervalMs: 60_000 });
    try {
      await h._tick();
      await h._tick();
      await h._tick();
      expect(getHealthSnapshot("backend")?.consecutiveFailures).toBe(3);
      expect(isAgentAvailable("backend")).toBe(false);
      expect(pickAvailableAgent("backend")?.role).toBe("tgdev");
    } finally {
      h.stop();
    }
  });

  test("stop() снимает свои ключи и не трогает чужие", async () => {
    const other = startHealthMonitor({ bots: [dead("frontend")], intervalMs: 60_000 });
    try {
      await other._tick();
      await runAndStop([dead("backend"), live("qa")], 1);
      expect(getHealthSnapshot("backend")).toBeUndefined();
      expect(getHealthSnapshot("qa")).toBeUndefined();
      // Чужая запись на месте: отменять её мы не вправе.
      expect(getHealthSnapshot("frontend")?.alive).toBe(false);
    } finally {
      other.stop();
    }
    expect(getHealthSnapshot("frontend")).toBeUndefined();
  });

  test("здоровый бот тоже уходит из реестра — правило одно на оба исхода", async () => {
    await runAndStop([live("backend")], 2);
    expect(getHealthSnapshot("backend")).toBeUndefined();
  });

  test("_resetHealthRegistry чистит всё, что пережило бы экземпляр", async () => {
    const h = startHealthMonitor({ bots: [dead("backend")], intervalMs: 60_000 });
    try {
      await h._tick();
      expect(getHealthSnapshot("backend")).toBeDefined();
      _resetHealthRegistry();
      expect(getHealthSnapshot("backend")).toBeUndefined();
    } finally {
      h.stop();
    }
  });
});

describe("подпись реестра называет того, кто его наполняет", () => {
  test("докблок больше не приписывает наполнение onSnapshot", () => {
    const src = read("lib/health.ts");
    const doc = src.slice(
      src.indexOf(" * Process-global registry"),
      src.indexOf("const HEALTH_REGISTRY"),
    );
    expect(doc).not.toContain("Populated by\n * the active monitor's onSnapshot callback");
    expect(doc).toContain("`runTick` напрямую, БЕЗУСЛОВНО");
  });

  test("наполнение и правда безусловное — onSnapshot необязателен", async () => {
    // Монитор без onSnapshot вовсе: запись всё равно появляется.
    const h = startHealthMonitor({ bots: [live("backend")], intervalMs: 60_000 });
    try {
      await h._tick();
      expect(getHealthSnapshot("backend")?.alive).toBe(true);
    } finally {
      h.stop();
    }
    // И код пишет в реестр до вызова onSnapshot, а не из него.
    const src = read("lib/health.ts");
    const body = src.slice(src.indexOf("const runTick"), src.indexOf("* Один тик за раз"));
    expect(body.indexOf("HEALTH_REGISTRY.set")).toBeGreaterThan(-1);
    expect(body.indexOf("HEALTH_REGISTRY.set")).toBeLessThan(body.indexOf("deps.onSnapshot"));
  });

  test("fail-open в role-skills стоит именно на отсутствии записи", () => {
    const src = read("lib/role-skills.ts");
    expect(src).toContain("if (!snap) return true;");
    expect(src).toContain("if (snap.consecutiveFailures > 2) return false;");
  });
});
