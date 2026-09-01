/**
 * Аудит 2026-08-28: «Остановить всё» отвечало «остановил», когда кадр не ушёл.
 *
 * `stopMac()` звала `activeSocket.send(...)` внутри try/catch и, если не
 * бросило, отвечала `{ ok: true }`. Bun на отброшенном кадре НЕ бросает —
 * `ServerWebSocket.send()` возвращает число: байты при успехе, `-1` при
 * backpressure (кадр принят и уйдёт) и `0`, когда кадр отброшен. Проверено
 * живым сокетом в «предпосылках» ниже: на закрытом соединении `send()` вернул
 * `0` и промолчал. То есть catch не срабатывал никогда, и ветка «не доставили»
 * была недостижима.
 *
 * Дальше хуже: сразу за отправкой шёл `failAllPending("mac_stopped")` — записи
 * о запусках стирались. Владелец видел «остановлено», мост забывал про
 * прогоны, а `claude` на маке продолжал работать: отменить его больше нечем,
 * id прогонов уже выброшены.
 *
 * Тот же игнор возврата был в `sendToMac`: отброшенный кадр `run` оставлял
 * запись в `pending`, и вызывающий ждал пять минут (RUN_TIMEOUT_MS) прогона,
 * который никогда не начинался.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { sendToMac, stopMac, _setActiveSocketForTests } from "../lib/mac-bridge.ts";

afterEach(() => {
  // Снимает и сокет, и таймеры оставшихся записей: bun гоняет весь каталог
  // одним процессом.
  _setActiveSocketForTests(null);
});

/** Сокет, у которого `send` отдаёт ровно то, что отдал бы Bun. */
function socketReturning(ret: number): { send: (s: string) => number; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(s: string) {
      sent.push(s);
      return ret;
    },
  };
}

async function state(p: Promise<unknown>): Promise<"resolved" | "rejected" | "pending"> {
  return await Promise.race([
    p.then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), 30)),
  ]);
}

describe("предпосылки", () => {
  test("Bun на отброшенном кадре возвращает 0, а не бросает", async () => {
    // Ровно поэтому try/catch вокруг send() ничего не ловил.
    let peer: { send: (s: string) => number; close: () => void } | null = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no")),
      websocket: {
        open(ws) {
          peer = ws as unknown as typeof peer;
        },
        message() {},
      },
    });
    const client = new WebSocket(`ws://127.0.0.1:${server.port}/`);
    await new Promise<void>((r) => client.addEventListener("open", () => r()));
    await new Promise((r) => setTimeout(r, 30));
    const live = peer!.send('{"type":"stop"}');
    peer!.close();
    await new Promise((r) => setTimeout(r, 80));
    let threw = false;
    let dropped: number | undefined;
    try {
      dropped = peer!.send('{"type":"stop"}');
    } catch {
      threw = true;
    }
    server.stop(true);
    expect(live).toBeGreaterThan(0);
    expect(threw).toBe(false);
    expect(dropped).toBe(0);
  });
});

describe("stopMac", () => {
  test("отброшенный кадр — это не успех", async () => {
    _setActiveSocketForTests(socketReturning(0));
    const res = await stopMac();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("stop_not_delivered");
  });

  test("не доставили — не стираем записи о прогонах", async () => {
    // Стереть их значило бы забыть id, по которым прогон ещё можно отменить.
    const sock = socketReturning(0);
    _setActiveSocketForTests({
      send: (s: string) => (JSON.parse(s).type === "run" ? 12 : sock.send(s)),
    });
    const run = sendToMac({ project: "/x", prompt: "p", mode: "ask" });
    const res = await stopMac();
    expect(res.ok).toBe(false);
    expect(await state(run)).toBe("pending");
  });

  test("backpressure — кадр принят, это успех", async () => {
    _setActiveSocketForTests(socketReturning(-1));
    expect(await stopMac()).toEqual({ ok: true });
  });

  test("доставленный кадр по-прежнему даёт ok и гасит прогоны", async () => {
    const sock = socketReturning(15);
    _setActiveSocketForTests(sock);
    const run = sendToMac({ project: "/x", prompt: "p", mode: "ask" });
    const res = await stopMac();
    expect(res).toEqual({ ok: true });
    await expect(run).rejects.toThrow("mac_stopped");
    expect(JSON.parse(sock.sent.at(-1)!)).toEqual({ type: "stop" });
  });

  test("send бросил — прежний ответ с текстом ошибки", async () => {
    _setActiveSocketForTests({
      send: () => {
        throw new Error("write failed");
      },
    });
    const res = await stopMac();
    expect(res.ok).toBe(false);
    expect(res.error).toBe("write failed");
  });
});

describe("sendToMac", () => {
  test("отброшенный кадр run отвечает сразу, а не через пять минут", async () => {
    _setActiveSocketForTests(socketReturning(0));
    const run = sendToMac({ project: "/x", prompt: "p", mode: "ask" });
    // Сначала «ответил ли вообще»: до правки запись просто оставалась в
    // pending, и ждать её пришлось бы RUN_TIMEOUT_MS.
    expect(await state(run)).toBe("rejected");
    await expect(run).rejects.toThrow("mac_send_dropped");
  });

  test("отброшенный run не занимает слот и не оставляет записи", async () => {
    // Иначе после нескольких таких отправок мост отвечал бы mac_busy на пустом
    // pending до самого таймаута.
    const sock = { calls: 0, send(_s: string) { return this.calls++ === 0 ? 0 : 12; } };
    _setActiveSocketForTests(sock);
    const first = sendToMac({ project: "/x", prompt: "p", mode: "ask" });
    expect(await state(first)).toBe("rejected");
    await expect(first).rejects.toThrow("mac_send_dropped");
    const second = sendToMac({ project: "/x", prompt: "p", mode: "ask" });
    expect(await state(second)).toBe("pending");
  });
});
