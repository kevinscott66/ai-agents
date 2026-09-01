/**
 * Аудит 2026-08-21: пустой allow-list чатов был невидим для оператора.
 *
 * Граница `isAllowlisted` fail-closed с T-603: пустой или криво распаршенный
 * `TELEGRAM_ALLOWED_GROUP_IDS` запрещает ВСЕМ. Значит одна опечатка в .env
 * (лишняя кавычка, пустая строка после переноса) выключает команду из 12
 * ботов целиком — они продолжают стартовать и молчать.
 *
 * Что при этом видел оператор до фикса:
 *   1. `Allowed chats: (any)` — стартовая строка `orchestrator-team.ts`,
 *      прод-точка входа (`bun run start`). Читается ровно наоборот:
 *      «ограничений нет». То же самое в `orchestrator-bot.ts`.
 *   2. Ничего больше. `warnIfEmptyAllowlist` звали Mini App
 *      (`auth-middleware.ts:46`) и ингест юзербота (`makeHandler` в
 *      `userbot.ts`), а путь
 *      апдейтов ботов — то есть основной путь прода — не звал никто.
 *
 * Формулировку знала только диагностическая точка входа
 * `orchestrator-userbot.ts` («none — fail-closed, отвечать некому»). Она и
 * взята за образец, а сама строка сведена в одну функцию `describeAllowlist`
 * — тем же приёмом, каким раньше свели разбор списка в `parseUserIdList`.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  describeAllowlist,
  warnIfEmptyAllowlist,
  isAllowlisted,
  _resetAllowlistWarnings,
} from "../lib/allowlist.ts";
import { log } from "../lib/log.ts";

const ENTRYPOINTS = [
  "orchestrator-team.ts",
  "orchestrator-bot.ts",
  "orchestrator-userbot.ts",
] as const;

function readEntry(name: string): string {
  return readFileSync(join(import.meta.dir, "..", name), "utf8");
}

afterEach(() => {
  _resetAllowlistWarnings();
});

describe("describeAllowlist называет пустой список тем, чем он является", () => {
  test("пустой список — это запрет всем, а не «любой чат»", () => {
    const text = describeAllowlist([]);
    // Главное: строка не должна читаться как «ограничений нет».
    expect(text).not.toContain("any");
    expect(text).toContain("fail-closed");
    // И тот же ответ на отсутствующий/битый конфиг.
    expect(describeAllowlist(undefined)).toBe(text);
    expect(describeAllowlist(null)).toBe(text);
  });

  test("непустой список печатается как есть", () => {
    expect(describeAllowlist(["-1001", "-1002"])).toBe("-1001,-1002");
    expect(describeAllowlist([42])).toBe("42");
  });

  test("описание согласовано с реальным решением границы", () => {
    // Ради чего вся правка: описание и поведение должны совпадать. Пустой
    // список действительно отвергает — включая id, который в непустом
    // списке прошёл бы.
    expect(isAllowlisted("-1001", [])).toBe(false);
    expect(isAllowlisted("-1001", ["-1001"])).toBe(true);
    expect(describeAllowlist([]).includes("не обслуживается")).toBe(true);
  });
});

describe("пустой список чатов поднимает громкий warn", () => {
  test("warnIfEmptyAllowlist пишет [security] с названием переменной", () => {
    const seen: string[] = [];
    const orig = log.warn;
    log.warn = ((msg: string, ...rest: unknown[]) => {
      seen.push(msg);
      return (orig as any).call(log, msg, ...rest);
    }) as typeof log.warn;
    try {
      const empty = warnIfEmptyAllowlist("TELEGRAM_ALLOWED_GROUP_IDS (bot updates)", []);
      expect(empty).toBe(true);
      // Непустой список молчит — предупреждение не должно стать шумом.
      expect(warnIfEmptyAllowlist("TELEGRAM_ALLOWED_GROUP_IDS (other)", ["-1001"])).toBe(false);
    } finally {
      log.warn = orig;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("[security]");
    expect(seen[0]).toContain("TELEGRAM_ALLOWED_GROUP_IDS (bot updates)");
    expect(seen[0]).toContain("fail-closed");
  });
});

describe("точки входа не рекламируют пустой список как «(any)»", () => {
  // Стартовые строки живут в модульном коде точек входа: импорт файла поднял
  // бы Telegraf и клиент gramjs. Поэтому здесь проверка источника — как в
  // сторожах allowlist-логов рядом.
  for (const name of ENTRYPOINTS) {
    test(`${name} печатает список через общую функцию`, () => {
      const src = readEntry(name);
      expect(src).toContain("describeAllowlist(");
      expect(src).not.toContain('"(any)"');
      // И обратная проверка: сама строка про allowlist из лога не выкинута.
      expect(/Allowed[ _a-z]*:/i.test(src)).toBe(true);
    });
  }

  test("прод-точка входа зовёт warnIfEmptyAllowlist для чатов", () => {
    const src = readEntry("orchestrator-team.ts");
    expect(src).toContain("warnIfEmptyAllowlist(");
    expect(src).toContain("TELEGRAM_ALLOWED_GROUP_IDS (bot updates)");
  });
});
