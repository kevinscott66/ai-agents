import { afterEach, describe, expect, test } from "bun:test";
import { isAdmin } from "../miniapp/src/lib/tg.ts";

const originalWindow = (globalThis as any).window;

afterEach(() => {
  if (originalWindow === undefined) delete (globalThis as any).window;
  else (globalThis as any).window = originalWindow;
});

describe("Mini App client admin helper", () => {
  test("fails closed outside Telegram", () => {
    delete (globalThis as any).window;
    expect(isAdmin()).toBe(false);
  });

  test("does not trust Telegram user presence as an admin claim", () => {
    (globalThis as any).window = {
      Telegram: { WebApp: { initDataUnsafe: { user: { id: 123 } } } },
    };
    expect(isAdmin()).toBe(false);
  });
});
