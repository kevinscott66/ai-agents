/**
 * Аудит 2026-08-13: брошенный по таймауту прогон продолжал работать на маке.
 *
 * По RUN_TIMEOUT_MS мост выбрасывал запись из `pending` и отвечал вызывающему
 * `mac_timeout`. На маке при этом не менялось НИЧЕГО: процесс `claude` шёл
 * дальше, писал в проект владельца (в режиме `bypass` — выполняя команды без
 * спроса) и слал чанки под id, который больше никто не ждёт. Точечной отмены в
 * протоколе не было вовсе: единственный кадр `stop` убивает все прогоны разом,
 * включая чужой живой.
 *
 * Оттуда же вторая половина: числа одновременных прогонов никто не ограничивал.
 * Повторные попытки складывались — через пять минут мост звал ещё один
 * `claude`, а предыдущий всё ещё работал в том же каталоге.
 *
 * И третья, на стороне демона: остановка была одним лишь SIGINT. Это просьба, а
 * не приказ; процесс, который её игнорирует, оставался жить после закрытия
 * сокета — причём демон уже забыл о нём (`activeChildren.clear()`).
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  sendToMac,
  _setActiveSocketForTests,
  _handleClientMessageForTests as feed,
} from "../lib/mac-bridge.ts";
import {
  killChild,
  cancelRun,
  killAll,
  type KillableChild,
} from "../mac-daemon/kill.ts";

function fakeSocket() {
  const sent: any[] = [];
  return {
    // Аудит 2026-08-28: мост принимает кадры только от АКТИВНОГО сокета, так
    // что заглушка обязана быть тем же объектом, что и activeSocket.
    data: { authed: true, peerKey: "test" },
    sent,
    send(raw: string) {
      sent.push(JSON.parse(raw));
    },
    close() {},
    lastRunId(): string {
      const run = [...sent].reverse().find((m) => m.type === "run");
      return String(run?.id ?? "");
    },
  };
}

/** Процесс-заглушка: помнит сигналы и выходит только если ему это разрешено. */
function fakeChild(opts: { exitsOnSigint: boolean }) {
  const signals: string[] = [];
  let done!: () => void;
  const exited = new Promise<void>((r) => {
    done = r;
  });
  return {
    signals,
    exited,
    kill(sig?: number | NodeJS.Signals) {
      signals.push(String(sig));
      if (sig === "SIGINT" && opts.exitsOnSigint) done();
      if (sig === "SIGKILL") done();
    },
  } satisfies KillableChild & { signals: string[] };
}

const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}

afterEach(() => {
  _setActiveSocketForTests(null);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
});

describe("мост: таймаут прогона останавливает процесс на маке", () => {
  test("по таймауту уходит cancel с тем же id, и только потом отказ", async () => {
    setEnv("MAC_RUN_TIMEOUT_MS", "30");
    const sock = fakeSocket();
    _setActiveSocketForTests(sock);

    const p = sendToMac({ project: "/tmp/x", prompt: "hi", mode: "bypass" });
    const id = sock.lastRunId();
    expect(id).not.toBe("");

    await expect(p).rejects.toThrow(/mac_timeout/);

    // До правки здесь был только кадр `run`: мост переставал слушать, а мак
    // продолжал работать.
    const cancels = sock.sent.filter((m) => m.type === "cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].id).toBe(id);
    // Именно точечная отмена, а не «убить всё» — чужой прогон не трогаем.
    expect(sock.sent.some((m) => m.type === "stop")).toBe(false);
  });

  test("успевший прогон не получает никакой отмены", async () => {
    setEnv("MAC_RUN_TIMEOUT_MS", "5000");
    const sock = fakeSocket();
    _setActiveSocketForTests(sock);

    const p = sendToMac({ project: "/tmp/x", prompt: "hi", mode: "ask" });
    const id = sock.lastRunId();
        feed(sock, JSON.stringify({ type: "result", id, ok: true, code: 0 }));

    const res = await p;
    expect(res.ok).toBe(true);
    expect(sock.sent.some((m) => m.type === "cancel")).toBe(false);
  });
});

describe("мост: предел одновременных прогонов", () => {
  test("сверх предела — отказ сразу, а не ещё один claude на маке", async () => {
    setEnv("MAC_MAX_CONCURRENT_RUNS", "1");
    setEnv("MAC_RUN_TIMEOUT_MS", "5000");
    const sock = fakeSocket();
    _setActiveSocketForTests(sock);

    const first = sendToMac({ project: "/tmp/x", prompt: "a", mode: "ask" });
    const id = sock.lastRunId();

    await expect(
      sendToMac({ project: "/tmp/x", prompt: "b", mode: "ask" }),
    ).rejects.toThrow(/mac_busy/);
    // Второй кадр `run` на мак не ушёл.
    expect(sock.sent.filter((m) => m.type === "run")).toHaveLength(1);

    // Как только первый завершился, место освобождается.
        feed(sock, JSON.stringify({ type: "result", id, ok: true, code: 0 }));
    await first;

    const third = sendToMac({ project: "/tmp/x", prompt: "c", mode: "ask" });
    expect(sock.sent.filter((m) => m.type === "run")).toHaveLength(2);
    _setActiveSocketForTests(null);
    await expect(third).rejects.toThrow();
  });

  test("мусор в MAC_MAX_CONCURRENT_RUNS не отключает предел", async () => {
    setEnv("MAC_MAX_CONCURRENT_RUNS", "0");
    setEnv("MAC_RUN_TIMEOUT_MS", "5000");
    const sock = fakeSocket();
    _setActiveSocketForTests(sock);

    // Ноль и мусор откатываются к умолчанию 2, а не к «сколько угодно».
    const a = sendToMac({ project: "/tmp/x", prompt: "a", mode: "ask" });
    const b = sendToMac({ project: "/tmp/x", prompt: "b", mode: "ask" });
    await expect(
      sendToMac({ project: "/tmp/x", prompt: "c", mode: "ask" }),
    ).rejects.toThrow(/mac_busy/);

    _setActiveSocketForTests(null);
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
  });
});

describe("демон: остановка процесса доводится до конца", () => {
  test("послушный процесс выходит по SIGINT, добивать нечем", async () => {
    const ch = fakeChild({ exitsOnSigint: true });
    expect(await killChild(ch, 50)).toBe("exited");
    expect(ch.signals).toEqual(["SIGINT"]);
  });

  test("процесс, игнорирующий SIGINT, добивается SIGKILL", async () => {
    // Ровно тот случай, ради которого правка: раньше демон посылал SIGINT,
    // делал clear() и забывал о процессе — тот жил дальше уже ничей.
    const ch = fakeChild({ exitsOnSigint: false });
    expect(await killChild(ch, 20)).toBe("killed");
    expect(ch.signals).toEqual(["SIGINT", "SIGKILL"]);
  });

  test("cancelRun убивает только свой прогон", async () => {
    const mine = fakeChild({ exitsOnSigint: true });
    const other = fakeChild({ exitsOnSigint: true });
    const map = new Map<string, KillableChild>([
      ["r_mine", mine],
      ["r_other", other],
    ]);

    expect(cancelRun(map, "r_mine", 20)).toBe(true);
    await mine.exited;
    expect(mine.signals).toEqual(["SIGINT"]);
    expect(other.signals).toEqual([]);
    expect([...map.keys()]).toEqual(["r_other"]);
  });

  test("отмена уже завершившегося прогона — не ошибка", () => {
    // Кадр отмены летит по сети; процесс мог успеть выйти сам.
    const map = new Map<string, KillableChild>();
    expect(cancelRun(map, "r_gone", 20)).toBe(false);
  });

  test("killAll возвращает число прогонов и очищает карту", async () => {
    const a = fakeChild({ exitsOnSigint: true });
    const b = fakeChild({ exitsOnSigint: false });
    const map = new Map<string, KillableChild>([
      ["a", a],
      ["b", b],
    ]);
    expect(killAll(map, 20)).toBe(2);
    expect(map.size).toBe(0);
    await b.exited; // добит SIGKILL
    expect(b.signals).toEqual(["SIGINT", "SIGKILL"]);
  });
});
