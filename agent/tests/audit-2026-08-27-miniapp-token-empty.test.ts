/**
 * Аудит 2026-08-27: fallback на токен оркестратора умирает второй раз — теперь
 * не от опечатки в имени переменной, а от `??`.
 *
 * Докстрока `getBotTokenForAuth` уже описывает, чем это кончилось в прошлый
 * раз: мёртвый fallback + текст ошибки, советующий чинить конфиг способом,
 * который ломает auth тише. `??` воскрешает ровно ту же беду условно —
 * `MINIAPP_BOT_TOKEN=` (пустая строка) не nullish, поэтому fallback не
 * срабатывает, и сервер отказывается стартовать, называя переменную, которая
 * задана. Пустая строка — не экзотика, а обычный способ «выключить»
 * переменную в .env-файле.
 *
 * Заодно `.trim()`: значение из dotenv легко приезжает с хвостовым переводом
 * строки, а токен уходит в HMAC как есть — тогда стартует всё, а «bad hash»
 * получают все пользователи разом. Это тот самый тихий отказ, от которого
 * докстрока и предостерегает.
 */
import { describe, expect, test } from "bun:test";
import { getBotTokenForAuth } from "../lib/miniapp-auth.ts";

const ORCH_ENV = "TELEGRAM_BOT_TOKEN";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("getBotTokenForAuth: пустой MINIAPP_BOT_TOKEN не должен убивать fallback", () => {
  test("MINIAPP_BOT_TOKEN= (пустая строка) → берём токен оркестратора", () => {
    withEnv({ MINIAPP_BOT_TOKEN: "", [ORCH_ENV]: "orch-token" }, () => {
      expect(getBotTokenForAuth()).toBe("orch-token");
    });
  });

  test("MINIAPP_BOT_TOKEN из одних пробелов → тоже fallback", () => {
    withEnv({ MINIAPP_BOT_TOKEN: "   ", [ORCH_ENV]: "orch-token" }, () => {
      expect(getBotTokenForAuth()).toBe("orch-token");
    });
  });

  test("хвостовой перевод строки срезается, а не уезжает в HMAC", () => {
    withEnv({ MINIAPP_BOT_TOKEN: "123:mini\n", [ORCH_ENV]: "orch-token" }, () => {
      expect(getBotTokenForAuth()).toBe("123:mini");
    });
  });

  test("пустой fallback тоже не считается токеном", () => {
    withEnv({ MINIAPP_BOT_TOKEN: "", [ORCH_ENV]: "  " }, () => {
      let message = "";
      try {
        getBotTokenForAuth();
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toContain("MINIAPP_BOT_TOKEN");
      expect(message).toContain(ORCH_ENV);
    });
  });

  test("контроль: заданный MINIAPP_BOT_TOKEN по-прежнему главнее", () => {
    withEnv({ MINIAPP_BOT_TOKEN: "primary", [ORCH_ENV]: "orch-token" }, () => {
      expect(getBotTokenForAuth()).toBe("primary");
    });
  });

  test("контроль: обе переменные не заданы — по-прежнему ошибка", () => {
    withEnv({ MINIAPP_BOT_TOKEN: undefined, [ORCH_ENV]: undefined }, () => {
      expect(() => getBotTokenForAuth()).toThrow(/no bot token/);
    });
  });
});
