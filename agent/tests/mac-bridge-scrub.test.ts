/**
 * Аудит 2026-08-13: вывод прогона на маке шёл мимо скруббера секретов.
 *
 * `claude` на Mac запускает произвольные команды. `git push` по HTTPS печатает
 * в stderr `https://x-access-token:ghp_…@github.com/…`, curl и npm — свои
 * токены. Демон при ненулевом коде выхода кладёт хвост stderr в поле `error`
 * кадра `result`, и дальше строка идёт двумя дорогами: в чат и в
 * `agent_actions.error` — то есть в SQLite на диск и наружу админам через
 * /api/actions. Скруббер не звала ни одна: `getErrorMessage` чистит только
 * ИСКЛЮЧЕНИЯ, а тут ошибка приезжает готовой строкой по сокету.
 *
 * Тесты идут через тот же вход, что и настоящий сокет (`_handleClientMessage-
 * ForTests`), чтобы проверялся путь целиком, а не отдельная функция.
 */
import { describe, test, expect, afterEach } from "bun:test";
import {
  sendToMac,
  _setActiveSocketForTests,
  _handleClientMessageForTests as feed,
  type MacRunResult,
  type MacStreamSnapshot,
} from "../lib/mac-bridge.ts";

const TG_TOKEN = "7123456789:AAF-abcdefghijklmnopqrstuvwxyz012345";
const GH_URL = "https://api.example.com/x?token=ghp_supersecretvalue123456";

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


/** Отправить прогон, скормить кадры, дождаться результата. */
function run(
  frames: (id: string) => Array<Record<string, unknown>>,
  onProgress?: (s: MacStreamSnapshot) => void,
): Promise<MacRunResult> {
  const sock = fakeSocket();
  _setActiveSocketForTests(sock);
  const p = sendToMac({
    project: "/tmp/x",
    prompt: "hi",
    mode: "ask",
    onProgress,
  });
  const id = sock.lastRunId();
  for (const f of frames(id)) feed(sock, JSON.stringify({ ...f, id }));
  return p;
}

afterEach(() => {
  _setActiveSocketForTests(null);
});

describe("поле error из кадра result чистится", () => {
  test("токен Telegram в хвосте stderr не доезжает до agent_actions", async () => {
    const res = await run((id) => [
      {
        type: "result",
        ok: false,
        code: 1,
        error: `exit 1: curl https://api.telegram.org/bot${TG_TOKEN}/getMe failed`,
      },
    ]);
    expect(res.error).not.toContain("AAF-abcdefghijklmnopqrstuvwxyz012345");
    expect(res.error).toContain("***");
    // Диагностика обязана уцелеть: без «exit 1» и bot_id сообщение бесполезно.
    expect(res.error).toContain("exit 1");
    expect(res.error).toContain("7123456789");
  });

  test("токен в query-строке тоже чистится", async () => {
    const res = await run((id) => [
      { type: "result", ok: false, code: 1, error: `exit 1: GET ${GH_URL}` },
    ]);
    expect(res.error).not.toContain("ghp_supersecretvalue123456");
    expect(res.error).toContain("token=***");
  });

  test("отсутствующий error остаётся undefined", async () => {
    const res = await run((id) => [{ type: "result", ok: true, code: 0 }]);
    expect(res.error).toBeUndefined();
  });
});

describe("stdout/stderr чистятся в итоге и в прогрессе", () => {
  test("секрет из stderr не попадает в результат", async () => {
    const res = await run((id) => [
      {
        type: "chunk",
        stream: "stderr",
        data: `fatal: unable to access 'https://x:${TG_TOKEN}@github.com/'`,
      },
      { type: "result", ok: false, code: 128 },
    ]);
    expect(res.stderr).not.toContain("AAF-abcdefghijklmnopqrstuvwxyz012345");
    expect(res.stderr).toContain("fatal: unable to access");
  });

  test("секрет из stdout не попадает в результат", async () => {
    const res = await run((id) => [
      { type: "chunk", stream: "stdout", data: `Authorization: Bearer sk-ant-abc123XYZ` },
      { type: "result", ok: true, code: 0 },
    ]);
    expect(res.stdout).not.toContain("sk-ant-abc123XYZ");
    expect(res.stdout).toContain("Bearer ***");
  });

  test("onProgress получает уже вычищенный хвост", async () => {
    const seen: string[] = [];
    await run(
      (id) => [
        { type: "chunk", stream: "stderr", data: `GET ${GH_URL} -> 401` },
        { type: "result", ok: true, code: 0 },
      ],
      (s) => seen.push(s.stderr),
    );
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      expect(s).not.toContain("ghp_supersecretvalue123456");
    }
  });

  test("длины считаются по сырому потоку, а не по вычищенному", async () => {
    // Иначе «сколько утекло» врало бы: подстановка *** короче секрета.
    const data = `GET ${GH_URL} -> 401`;
    const res = await run((id) => [
      { type: "chunk", stream: "stdout", data },
      { type: "result", ok: true, code: 0 },
    ]);
    expect(res.stdoutLen).toBe(data.length);
    expect(res.stdout.length).toBeLessThan(data.length);
  });

  test("обычный вывод без секретов не меняется", async () => {
    const res = await run((id) => [
      { type: "chunk", stream: "stdout", data: "2589 pass, 0 fail\n" },
      { type: "result", ok: true, code: 0 },
    ]);
    expect(res.stdout).toBe("2589 pass, 0 fail\n");
  });
});
