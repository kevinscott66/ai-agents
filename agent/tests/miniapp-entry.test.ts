import { describe, expect, test } from "bun:test";
import {
  configureMiniAppMenuButton,
  resolveMiniAppPublicUrl,
  DEFAULT_MINIAPP_PUBLIC_URL,
  MINIAPP_MENU_BUTTON_TEXT,
  type MiniAppMenuClient,
} from "../lib/miniapp-entry.ts";

describe("Mini App Lead entry point", () => {
  test("accepts the public HTTPS URL and normalizes it", () => {
    expect(resolveMiniAppPublicUrl(" https://agents.example.test:8443/ ")).toEqual({
      ok: true,
      url: "https://agents.example.test:8443/",
    });
  });

  test("rejects URLs that cannot be safe Telegram Web App entries", () => {
    expect(resolveMiniAppPublicUrl("")).toEqual({ ok: false, reason: "missing_url" });
    expect(resolveMiniAppPublicUrl("http://agents.example.test")).toEqual({ ok: false, reason: "invalid_url" });
    expect(resolveMiniAppPublicUrl("https://agents.example.test/panel?token=redacted-example")).toEqual({ ok: false, reason: "invalid_url" });
  });

  test("configures the Lead bot menu button only after validation", async () => {
    const calls: unknown[] = [];
    const bot = {
      telegram: {
        setChatMenuButton: async (input: unknown) => {
          calls.push(input);
        },
      },
    };
    const result = await configureMiniAppMenuButton(bot, "https://agents.example.test:8443");
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{
      menuButton: {
        type: "web_app",
        text: MINIAPP_MENU_BUTTON_TEXT,
        web_app: { url: "https://agents.example.test:8443/" },
      },
    }]);

    await configureMiniAppMenuButton(bot, "http://agents.example.test");
    expect(calls).toHaveLength(1);
  });
});

/**
 * Аудит 2026-08-27: пустой MINIAPP_PUBLIC_URL обходил фолбэк.
 *
 * `resolveMiniAppPublicUrl` умеет подставлять DEFAULT_MINIAPP_PUBLIC_URL, но
 * `configureMiniAppMenuButton` читал env голым и передавал результат явно —
 * а дефолт параметра в JS срабатывает только на `undefined`. `.env.example`
 * отгружает переменную пустой, и на свежей машине кнопка «Панель» не
 * ставилась: missing_url при живом публичном адресе.
 */
describe("configureMiniAppMenuButton: пустой env не отменяет дефолт", () => {
  test('MINIAPP_PUBLIC_URL="" → кнопка ставится на дефолтный адрес', async () => {
    const before = process.env.MINIAPP_PUBLIC_URL;
    process.env.MINIAPP_PUBLIC_URL = "";
    try {
      const calls: string[] = [];
      const bot: MiniAppMenuClient = {
        telegram: {
          setChatMenuButton: async (input) => {
            calls.push(input.menuButton.web_app.url);
            return true;
          },
        },
      };
      const res = await configureMiniAppMenuButton(bot);
      expect(res.ok).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0]!.startsWith(DEFAULT_MINIAPP_PUBLIC_URL)).toBe(true);
    } finally {
      if (before === undefined) delete process.env.MINIAPP_PUBLIC_URL;
      else process.env.MINIAPP_PUBLIC_URL = before;
    }
  });

  test("явно переданная пустая строка по-прежнему отказ", async () => {
    const bot: MiniAppMenuClient = {
      telegram: {
        setChatMenuButton: async () => {
          throw new Error("не должно вызываться");
        },
      },
    };
    const res = await configureMiniAppMenuButton(bot, "");
    expect(res).toEqual({ ok: false, reason: "missing_url" });
  });
});
