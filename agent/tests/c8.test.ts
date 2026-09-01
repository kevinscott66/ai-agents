/**
 * C8: vision input + SEND_PHOTO + GENERATE_SVG_IMAGE.
 */
import { describe, test, expect, afterEach, mock } from "bun:test";
import { db } from "../lib/db.ts";
import { executeTool } from "../lib/tools-schema.ts";
import { dispatchAction } from "../lib/action-dispatch.ts";
import {
  getPermission,
  evaluateGate,
  setAutonomy,
} from "../lib/permissions.ts";
import { renderSvgToPng } from "../lib/svg-render.ts";
import { CHARACTERS } from "../characters/index.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_808;
const TEST_AGENT = "design";

let savedGlobal = saveAutonomy();
afterEach(() => {
  restoreAutonomy(savedGlobal);
  cleanupChat(TEST_CHAT);
  cleanupChat(TEST_CHAT, TEST_AGENT);
});

const TRIVIAL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="red"/></svg>';

/**
 * Аргументы, с которыми lib/telegram-actions.ts зовёт tg.sendPhoto:
 * (chatId, url | {source,filename}, extra). Сигнатуру задаём явно — иначе
 * mock.calls типизируется как пустой кортеж и проверки args[N] не работают.
 */
type SendPhotoArgs = [
  chatId: number | string,
  photo: string | { source: Buffer; filename?: string },
  extra?: Record<string, unknown>,
];

function fakeTg() {
  return {
    callApi: mock(() => Promise.resolve(true)),
    sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
    deleteMessage: mock(() => Promise.resolve(true)),
    editMessageText: mock(() => Promise.resolve(true)),
    pinChatMessage: mock(() => Promise.resolve(true)),
    forwardMessage: mock(() => Promise.resolve({ message_id: 1 })),
    sendPoll: mock(() => Promise.resolve({ message_id: 1 })),
    sendPhoto: mock((..._args: SendPhotoArgs) =>
      Promise.resolve({ message_id: 42 }),
    ),
  };
}

describe("migration 009: seed SEND_PHOTO + GENERATE_SVG_IMAGE permissions", () => {
  test("каждый из 12 агентов имеет allowed=1, requires_approval=0 для обоих типов", () => {
    for (const c of CHARACTERS) {
      for (const at of ["SEND_PHOTO", "GENERATE_SVG_IMAGE"] as const) {
        const p = getPermission(c.key, at);
        expect(p.allowed).toBe(true);
        expect(p.requires_approval).toBe(false);
      }
    }
  });
});

describe("renderSvgToPng", () => {
  test("производит непустой PNG-буфер с magic bytes", async () => {
    const buf = await renderSvgToPng(TRIVIAL_SVG);
    expect(buf.length).toBeGreaterThan(0);
    expect(buf.subarray(0, 4).toString("hex")).toBe("89504e47");
  });

  test("отклоняет SVG > 200KB", async () => {
    const big = "<svg xmlns=\"http://www.w3.org/2000/svg\">" +
      "x".repeat(200 * 1024 + 100) + "</svg>";
    await expect(renderSvgToPng(big)).rejects.toThrow(/too large/);
  });
});

describe("dispatchAction: GENERATE_SVG_IMAGE", () => {
  test("рендерит SVG и зовёт sendPhoto", async () => {
    const tg = fakeTg();
    const res = await dispatchAction(
      "GENERATE_SVG_IMAGE",
      { svg: TRIVIAL_SVG, caption: "hello" },
      {
        agentKey: TEST_AGENT,
        chatId: TEST_CHAT,
        telegram: tg as never,
      },
    );
    expect(res.ok).toBe(true);
    expect(tg.sendPhoto).toHaveBeenCalledTimes(1);
    const args = tg.sendPhoto.mock.calls[0];
    expect(args[0]).toBe(TEST_CHAT);
    const photoArg = args[1] as { source: Buffer };
    expect(Buffer.isBuffer(photoArg.source)).toBe(true);
    expect(photoArg.source.subarray(0, 4).toString("hex")).toBe("89504e47");
    expect((args[2] as { caption?: string }).caption).toBe("hello");
  });
});

describe("executeTool: SEND_PHOTO", () => {
  test("c URL и caption → sendPhoto вызван, ok:true", async () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const tg = fakeTg();
    const out = await executeTool(
      "SEND_PHOTO",
      { url: "https://example.com/a.png", caption: "x" },
      {
        agentKey: TEST_AGENT,
        chatId: TEST_CHAT,
        telegram: tg as never,
      },
    );
    const parsed = JSON.parse(out) as { ok: boolean; messageId?: number };
    expect(parsed.ok).toBe(true);
    expect(parsed.messageId).toBe(42);
    expect(tg.sendPhoto).toHaveBeenCalledTimes(1);
    expect(tg.sendPhoto.mock.calls[0][1]).toBe("https://example.com/a.png");
  });

  test("ни url ни base64 → ok:false", async () => {
    const tg = fakeTg();
    const out = await executeTool(
      "SEND_PHOTO",
      { caption: "x" },
      {
        agentKey: TEST_AGENT,
        chatId: TEST_CHAT,
        telegram: tg as never,
      },
    );
    const parsed = JSON.parse(out) as { ok: boolean; error?: string };
    expect(parsed.ok).toBe(false);
    expect(String(parsed.error ?? "")).toMatch(/url or base64/);
  });

  test("base64 → конвертируется в Buffer и шлётся как source", async () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    const tg = fakeTg();
    const png = await renderSvgToPng(TRIVIAL_SVG);
    const b64 = png.toString("base64");
    const out = await executeTool(
      "SEND_PHOTO",
      { base64: b64 },
      {
        agentKey: TEST_AGENT,
        chatId: TEST_CHAT,
        telegram: tg as never,
      },
    );
    const parsed = JSON.parse(out) as { ok: boolean };
    expect(parsed.ok).toBe(true);
    const photoArg = tg.sendPhoto.mock.calls[0][1] as { source: Buffer };
    expect(Buffer.isBuffer(photoArg.source)).toBe(true);
    expect(photoArg.source.subarray(0, 4).toString("hex")).toBe("89504e47");
  });
});

describe("evaluateGate: SEND_PHOTO + GENERATE_SVG_IMAGE в semi_auto → allow", () => {
  test("оба типа auto-allowed в semi_auto (не в SEMI_AUTO_RISKY)", () => {
    savedGlobal = saveAutonomy();
    setAutonomy("global", "*", "semi_auto");
    for (const at of ["SEND_PHOTO", "GENERATE_SVG_IMAGE"] as const) {
      const g = evaluateGate({
        agentKey: TEST_AGENT,
        actionType: at,
      });
      expect(g.decision).toBe("allow");
    }
  });
});
