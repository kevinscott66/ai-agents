import { describe, expect, test } from "bun:test";
import { sanitizeChildEnv } from "../mac-daemon/child-env.ts";

describe("Mac daemon child environment", () => {
  test("passes only explicit non-secret runtime variables", () => {
    const out = sanitizeChildEnv({
      PATH: "/usr/bin",
      HOME: "/Users/tester",
      LANG: "en_US.UTF-8",
      LC_ALL: "ru_RU.UTF-8",
      ANTHROPIC_API_KEY: "credential-not-forwarded",
      ANTHROPIC_MODEL: "credential-adjacent-not-forwarded",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_SESSION_TOKEN: "credential-not-forwarded",
      MAC_BRIDGE_SECRET: "credential-not-forwarded",
      TELEGRAM_BOT_TOKEN: "credential-not-forwarded",
      OPENAI_API_KEY: "credential-not-forwarded",
    });

    expect(out).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/tester",
      LANG: "en_US.UTF-8",
    });
    expect(Object.keys(out).some((key) =>
      key.startsWith("ANTHROPIC_") || key.startsWith("CLAUDE_")
    )).toBe(false);
  });

  /**
   * Аудит 2026-09-11: `PWD` наследовался от демона, а прогон запускается с
   * `cwd: allowedProject` — ребёнок получал путь, указывающий не туда, где он
   * работает, и обычно за пределы `MAC_PROJECT_ROOTS`.
   */
  test("PWD не наследуется от демона", () => {
    const out = sanitizeChildEnv({ PATH: "/usr/bin", PWD: "/Users/tester/daemon-home" });

    expect(out.PWD).toBeUndefined();
  });

  test("PWD выводится из каталога прогона", () => {
    const out = sanitizeChildEnv(
      { PATH: "/usr/bin", PWD: "/Users/tester/daemon-home" },
      "/Users/tester/projects/site",
    );

    expect(out.PWD).toBe("/Users/tester/projects/site");
  });

  test("пустой cwd не заводит пустую переменную", () => {
    // `PWD=""` — молчаливая ложь; без переменной `getcwd()` даёт правду.
    expect(sanitizeChildEnv({ PATH: "/usr/bin" }, "")).toEqual({ PATH: "/usr/bin" });
  });
});
