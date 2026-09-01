/**
 * Аудит 2026-08-28, lib/mac-bridge.ts — три дефекта.
 *
 * 1. Кадры принимались от ЛЮБОГО аутентифицированного сокета, а не только от
 *    активного. Хуже всего это било по `pong`: он двигает модульный
 *    lastPongTime, единственный вход isMacOnline(), а на нём висят /api/health,
 *    /readyz, прометеевский gauge и гейт в dispatch/mac.ts. Пришлый сокет
 *    держал мост «онлайн», пока настоящий демон молчал — то есть возвращал
 *    ровно ту дыру, которую жнец молчащего сокета закрыл 2026-08-08.
 *
 * 2. MAC_STREAM_TAIL_BYTES применялся через String.slice, то есть считал
 *    единицы UTF-16, а не байты. На кириллице потолок памяти был вдвое выше
 *    заявленного, на эмодзи — вчетверо, и срез мог разрубить суррогатную пару.
 *
 * 3. Служебные таймеры (ping-интервал, окно аутентификации) не были unref'нуты.
 */
import { describe, test, expect, afterEach, setSystemTime } from "bun:test";
import {
  sendToMac,
  isMacOnline,
  tailWithinBytes,
  MAC_STREAM_TAIL_BYTES,
  _setActiveSocketForTests,
  _handleClientMessageForTests as feed,
  type MacRunResult,
} from "../lib/mac-bridge.ts";

function socket(tag: string) {
  const sent: any[] = [];
  return {
    tag,
    data: { authed: true, peerKey: tag },
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

afterEach(() => {
  _setActiveSocketForTests(null);
});

describe("мост слушает только активный сокет", () => {
  test("pong от постороннего authed-сокета не воскрешает молчащий мост", () => {
    const live = socket("live");
    _setActiveSocketForTests(live);
    const t0 = Date.now();
    try {
      // Активный ответил — мост онлайн.
      feed(live, JSON.stringify({ type: "pong" }));
      expect(isMacOnline()).toBe(true);

      // Закрыли крышку: активный молчит дольше PING_TIMEOUT_MS (60 с).
      setSystemTime(new Date(t0 + 61_000));
      expect(isMacOnline()).toBe(false);

      // ГЛАВНОЕ: пришлый authed-сокет своим pong'ом НЕ обязан объявлять мост
      // живым. До фикса эта строка возвращала true, и /api/health, /readyz,
      // gauge и гейт dispatch дружно врали, что мак на связи.
      const stale = socket("stale");
      feed(stale, JSON.stringify({ type: "pong" }));
      expect(isMacOnline()).toBe(false);

      // …а pong настоящего активного — обязан.
      feed(live, JSON.stringify({ type: "pong" }));
      expect(isMacOnline()).toBe(true);
    } finally {
      setSystemTime();
    }
  });

  test("result от постороннего сокета не завершает чужой прогон", async () => {
    const live = socket("live");
    _setActiveSocketForTests(live);
    const p: Promise<MacRunResult> = sendToMac({
      project: "/tmp/x",
      prompt: "hi",
      mode: "ask",
    });
    const id = live.lastRunId();
    expect(id).not.toBe("");

    const stale = socket("stale");
    feed(stale, JSON.stringify({ type: "result", id, ok: true, code: 0 }));

    // Прогон обязан остаться висеть: чужой сокет его не закрывает.
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    // …а активный — закрывает.
    feed(live, JSON.stringify({ type: "result", id, ok: true, code: 0 }));
    const res = await p;
    expect(res.ok).toBe(true);
  });

  test("chunk от постороннего сокета не попадает в поток прогона", async () => {
    const live = socket("live");
    _setActiveSocketForTests(live);
    const p = sendToMac({ project: "/tmp/x", prompt: "hi", mode: "ask" });
    const id = live.lastRunId();

    const stale = socket("stale");
    feed(
      stale,
      JSON.stringify({ type: "chunk", id, stream: "stdout", data: "ЧУЖОЕ" }),
    );
    feed(
      live,
      JSON.stringify({ type: "chunk", id, stream: "stdout", data: "своё" }),
    );
    feed(live, JSON.stringify({ type: "result", id, ok: true, code: 0 }));

    const res = await p;
    expect(res.stdout).toBe("своё");
    expect(res.stdoutLen).toBe(4);
  });

  test("гвоздь в исходнике: проверка активности стоит до разбора кадров", async () => {
    const src = await Bun.file(
      new URL("../lib/mac-bridge.ts", import.meta.url),
    ).text();
    const guard = src.indexOf("if (activeSocket && ws !== activeSocket)");
    const chunk = src.indexOf('if (msg?.type === "chunk")');
    const pong = src.indexOf('if (msg?.type === "pong")');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(chunk);
    expect(guard).toBeLessThan(pong);
  });
});

describe("хвост потока ограничен байтами, а не единицами UTF-16", () => {
  test("ASCII: поведение прежнее — байт равен символу", () => {
    expect(tailWithinBytes("abcdef", 4)).toBe("cdef");
    expect(tailWithinBytes("abc", 10)).toBe("abc");
  });

  test("кириллица: держим байтовый бюджет, а не удвоенный", () => {
    // 100 символов по два байта = 200 байт; бюджет 50 байт = 25 символов.
    const s = "я".repeat(100);
    const tail = tailWithinBytes(s, 50);
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(50);
    expect(tail.length).toBe(25);
    expect(s.endsWith(tail)).toBe(true);
  });

  test("суррогатная пара не разрубается пополам", () => {
    const s = "x" + "😀".repeat(10); // эмодзи — 4 байта, 2 единицы UTF-16
    const tail = tailWithinBytes(s, 10); // не кратно 4 — граница пришлась бы внутрь
    expect(Buffer.byteLength(tail, "utf8")).toBeLessThanOrEqual(10);
    expect(tail).toBe("😀😀");
    // Ни одного одиночного суррогата.
    for (const ch of tail) expect(ch.codePointAt(0)! > 0xffff || ch === "x").toBe(true);
  });

  test("многобайтовый поток не превышает MAC_STREAM_TAIL_BYTES в памяти", async () => {
    const live = socket("live");
    _setActiveSocketForTests(live);
    const p = sendToMac({ project: "/tmp/x", prompt: "hi", mode: "ask" });
    const id = live.lastRunId();

    const chunk = "я".repeat(50_000); // 100 000 байт за кадр
    for (let i = 0; i < 4; i++) {
      feed(
        live,
        JSON.stringify({ type: "chunk", id, stream: "stdout", data: chunk }),
      );
    }
    feed(live, JSON.stringify({ type: "result", id, ok: true, code: 0 }));

    const res = await p;
    expect(Buffer.byteLength(res.stdout, "utf8")).toBeLessThanOrEqual(
      MAC_STREAM_TAIL_BYTES,
    );
    // До фикса здесь было бы 64 000 СИМВОЛОВ = 128 000 байт.
    expect(res.stdout.length).toBe(MAC_STREAM_TAIL_BYTES / 2);
    expect(res.stdoutLen).toBe(200_000);
    expect(res.truncated).toBe(true);
  });
});

describe("служебные таймеры не держат процесс", () => {
  test("гвоздь: ping-интервал и окно аутентификации unref'нуты", async () => {
    const src = await Bun.file(
      new URL("../lib/mac-bridge.ts", import.meta.url),
    ).text();
    expect(src).toContain("unrefTimer(pingInterval)");
    expect(src).toContain("unrefTimer(state.authTimer)");
    // Прогонный таймаут остаётся ref'нутым: он единственный зовёт cancelOnMac.
    expect(src).not.toContain("unrefTimer(timer)");
  });
});
