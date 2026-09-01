/**
 * Аудит 2026-08-08: мост копил поток с мака без лимита и не замечал мёртвый мак.
 *
 * 1. `p.stdout += data` росло до пяти минут (RUN_TIMEOUT_MS) в том же процессе,
 *    где 12 ботов, HTTP Mini App и планировщики. Демон режет только свой
 *    собственный stderrTail (600 символов «для диагностики»), а в сокет отдаёт
 *    каждый чанк как есть: `bun test`, сборка или вывод большого файла внутри
 *    прогона приезжали на VPS целиком. Потребитель при этом брал только хвост в
 *    3500 символов и длину — то есть накопленное отбрасывалось, оплатив собой
 *    риск OOM-kill юнита.
 *
 * 2. Молчащий мак не закрывался. isMacOnline() честно показывал offline в
 *    /api/health, но activeSocket оставался, а dispatch проверял только «сокет
 *    не null» — run уходил в пустоту, вызывающий висел пять минут и получал
 *    mac_timeout вместо немедленного mac_offline. Самый частый случай — закрытая
 *    крышка ноутбука, то есть не сбой, а норма.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  sendToMac,
  _setActiveSocketForTests,
  MAC_STREAM_TAIL_BYTES,
  _handleClientMessageForTests as feed,
  type MacRunResult,
} from "../lib/mac-bridge.ts";
import { handleMacRunClaude, type MacBridge } from "../lib/dispatch/mac.ts";

/** Сокет-заглушка: ловит исходящие кадры и умеет отвечать обратно в мост. */
function fakeSocket() {
  const sent: any[] = [];
  return {
    // Аудит 2026-08-28: кадры теперь принимаются только от АКТИВНОГО сокета,
    // поэтому заглушка обязана быть тем же объектом, что и activeSocket, и
    // нести `data.authed`. Раньше тесты кормили мост посторонним объектом
    // `{ data: { authed: true } }` — то есть проверяли ровно тот путь, который
    // фикс запрещает.
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

afterEach(() => {
  _setActiveSocketForTests(null);
});

describe("хвост потока ограничен, а длина остаётся честной", () => {
  test("MAC_STREAM_TAIL_BYTES заметно больше видимого в чате хвоста", () => {
    // Иначе обрезка меняла бы то, что видит человек, а не только память.
    expect(MAC_STREAM_TAIL_BYTES).toBeGreaterThan(3500 * 10);
  });

  test("многомегабайтный поток не оседает в памяти целиком", async () => {
    const sock = fakeSocket();
    _setActiveSocketForTests(sock);
    const p: Promise<MacRunResult> = sendToMac({
      project: "/tmp/x",
      prompt: "hi",
      mode: "ask",
    });
    const id = sock.lastRunId();
    expect(id).not.toBe("");

    // 4 МБ: до фикса ровно столько и оставалось бы висеть в PendingRun.
    const chunk = "A".repeat(64_000);
    const chunks = 64;
    for (let i = 0; i < chunks; i++) {
      feed(sock, JSON.stringify({ type: "chunk", id, stream: "stdout", data: chunk }));
    }
    feed(
      sock,
      JSON.stringify({ type: "result", id, ok: true, code: 0 }),
    );

    const res = await p;
    expect(res.ok).toBe(true);
    // В памяти — только хвост…
    expect(res.stdout.length).toBe(MAC_STREAM_TAIL_BYTES);
    // …а длина отражает всё, что пришло: иначе модель получила бы враньё.
    expect(res.stdoutLen).toBe(chunk.length * chunks);
    expect(res.truncated).toBe(true);
    // Хвост — это именно конец потока.
    expect(res.stdout.endsWith("A")).toBe(true);
  });

  test("короткий поток не обрезается и не помечается truncated", async () => {
    const sock = fakeSocket();
    _setActiveSocketForTests(sock);
    const p = sendToMac({ project: "/tmp/x", prompt: "hi", mode: "ask" });
    const id = sock.lastRunId();
    feed(
      sock,
      JSON.stringify({ type: "chunk", id, stream: "stdout", data: "done\n" }),
    );
    feed(
      sock,
      JSON.stringify({ type: "chunk", id, stream: "stderr", data: "warn\n" }),
    );
    feed(
      sock,
      JSON.stringify({ type: "result", id, ok: true, code: 0 }),
    );
    const res = await p;
    expect(res.stdout).toBe("done\n");
    expect(res.stderr).toBe("warn\n");
    expect(res.stdoutLen).toBe(5);
    expect(res.truncated).toBe(false);
  });
});

describe("dispatch спрашивает живость, а не «сокет не null»", () => {
  const payload = {
    project: "/tmp/x",
    prompt: "hi",
    mode: "ask" as const,
    _userId: "42",
  };

  function bridgeWith(over: Partial<MacBridge>): MacBridge {
    return {
      isMacConnected: () => true,
      sendToMac: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
      stopMac: async () => ({ ok: true }),
      isUserAllowed: () => true,
      ...over,
    };
  }

  test("подключён, но молчит дольше таймаута — сразу mac_offline", async () => {
    let sent = 0;
    const res = await handleMacRunClaude(payload as any, {
      agentKey: "backend",
      chatId: -1,
      macBridge: bridgeWith({
        isMacOnline: () => false,
        sendToMac: async () => {
          sent++;
          return { ok: true, code: 0, stdout: "", stderr: "" };
        },
      }),
    });
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("mac_offline");
    // До фикса run уходил в пустоту и вызывающий ждал RUN_TIMEOUT_MS.
    expect(sent).toBe(0);
  });

  test("живой мак работает как раньше", async () => {
    const res = await handleMacRunClaude(payload as any, {
      agentKey: "backend",
      chatId: -1,
      macBridge: bridgeWith({ isMacOnline: () => true }),
    });
    expect(res.ok).toBe(true);
  });

  test("заглушка без isMacOnline не ломается", async () => {
    // Старые тесты передают мост без признака живости — он должен считаться
    // рабочим, иначе фикс тихо запретил бы MAC_RUN_CLAUDE в них.
    const res = await handleMacRunClaude(payload as any, {
      agentKey: "backend",
      chatId: -1,
      macBridge: bridgeWith({}),
    });
    expect(res.ok).toBe(true);
  });
});
