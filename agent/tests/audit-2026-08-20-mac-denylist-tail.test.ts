/**
 * Повторный аудит 2026-08-20 по dispatch/mac.ts — два тихих отказа.
 *
 * 1. Аудит 2026-08-12 закрыл разбор MAC_DENIED_PROMPT_PATTERNS по запятым
 *    внутри `{n,m}`. Но у той же дыры остался второй вход: НЕЗАКРЫТАЯ `{` —
 *    то есть ровно та опечатка, из-за которой правило и ломается, — держала
 *    счётчик глубины до конца строки, и все последующие правила склеивались в
 *    одно. Склейка успешно компилируется (в JS без флага `u` незакрытая `{` —
 *    литерал) и не матчит ничего. Опять молча: переменная непустая и выглядит
 *    настроенной, а на том конце запускается Claude Code на машине владельца.
 *
 * 2. Хвост вывода в чат резался `slice(-3500)` — по code unit'ам. Лимит
 *    чётный, но нечётное число не-BMP символов в выводе сдвигает границу в
 *    середину суррогатной пары. Одиночный суррогат не имеет кодировки в UTF-8,
 *    которую требует Bot API, а отправка обёрнута в `.catch(() => {})` — то
 *    есть результат прогона пропадает целиком и беззвучно.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { parseDeniedPatterns, tailByCodePoints } from "../lib/dispatch/mac.ts";
import type { MacBridge } from "../lib/dispatch/mac.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_942;
const ENV = "MAC_DENIED_PROMPT_PATTERNS";

/**
 * Возвращаемый тип задан явно. Без него TS выводит `sendToMac` как
 * `() => Promise<never>` (тело только бросает), и тест ниже, который
 * подменяет sendToMac на реально отвечающий, не компилировался:
 *
 *   tests/audit-2026-08-20-mac-denylist-tail.test.ts(104,58):
 *   error TS2345: ... is not assignable to ... sendToMac: () => Promise<never>
 *
 * `bun test` этого не видит — типы стираются. Заодно заглушки теперь
 * сверяются с прод-контрактом MacBridge, а не сами с собой.
 */
function refusingBridge(): MacBridge {
  return {
    isMacConnected: () => true,
    isUserAllowed: () => true,
    sendToMac: async () => {
      throw new Error("should not reach sendToMac");
    },
    stopMac: async () => ({ ok: true }),
  };
}

async function runMac(prompt: string, bridge: MacBridge) {
  return dispatchAction(
    "MAC_RUN_CLAUDE",
    { project: "/Users/dobropalm/programs/foo", prompt, mode: "ask", _userId: "42" },
    { agentKey: "orchestrator", chatId: TEST_CHAT, macBridge: bridge },
  );
}

describe("parseDeniedPatterns: незакрытая '{' не съедает остальные правила", () => {
  test("несбалансированная '{' — ошибка, а не молчаливая склейка", () => {
    // До фикса возвращался один шаблон `rm\s{1,3-rf,cat /etc/passwd,sudo`,
    // который компилируется и не матчит ни одно из трёх правил.
    expect(() => parseDeniedPatterns("rm\\s{1,3-rf,cat /etc/passwd,sudo")).toThrow(
      /незакрытая/,
    );
  });

  test("одна незакрытая '{' в конце тоже ошибка", () => {
    expect(() => parseDeniedPatterns("sudo,rm\\s{1")).toThrow(/незакрытая/);
  });

  test("лишняя '}' без открывающей правила не теряет", () => {
    // depth не уходит в минус, поэтому запятая после `}` по-прежнему делит.
    expect(parseDeniedPatterns("a},b")).toEqual(["a}", "b"]);
  });

  test("экранированная '\\{' глубину не открывает — поведение прежнее", () => {
    expect(parseDeniedPatterns("a\\{x,y")).toEqual(["a\\{x", "y"]);
  });

  test("сбалансированный квантификатор разбирается как раньше", () => {
    expect(parseDeniedPatterns("rm\\s{1,3}-rf,sudo")).toEqual([
      "rm\\s{1,3}-rf",
      "sudo",
    ]);
  });
});

describe("MAC_RUN_CLAUDE на неразбираемом денилисте закрывается", () => {
  const before = process.env[ENV];
  const savedAutonomy = saveAutonomy();

  afterEach(() => {
    if (before === undefined) delete process.env[ENV];
    else process.env[ENV] = before;
    restoreAutonomy(savedAutonomy);
    cleanupChat(TEST_CHAT);
  });

  test("незакрытая '{' → отказ, до sendToMac не доходит", async () => {
    process.env[ENV] = "rm\\s{1,3-rf,cat /etc/passwd,sudo";
    // Промпт подпадает под ТРЕТЬЕ правило, которое до фикса просто исчезало.
    const res = await runMac("sudo cat /etc/passwd", refusingBridge());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("MAC_DENIED_PROMPT_PATTERNS");
  });

  test("сбалансированный денилист по-прежнему пропускает безобидный промпт", async () => {
    process.env[ENV] = "rm\\s{1,3}-rf";
    let reached = false;
    const bridge = {
      ...refusingBridge(),
      sendToMac: async () => {
        reached = true;
        return { ok: true, code: 0, stdout: "готово", stderr: "" };
      },
    };
    const res = await runMac("посчитай строки в README", bridge);
    expect(reached).toBe(true);
    expect(res.ok).toBe(true);
  });
});

describe("tailByCodePoints: хвост не разрезает суррогатную пару", () => {
  const LIMIT = 3500;
  const FIRE = "\u{1F525}";

  /** Длина подобрана так, чтобы граница среза легла в середину пары. */
  const splitting = "a".repeat(200) + FIRE.repeat(2000) + "b";

  test("старый slice действительно давал одиночный суррогат — контроль", () => {
    const old = splitting.slice(-LIMIT);
    const c = old.charCodeAt(0);
    expect(c).toBeGreaterThanOrEqual(0xdc00);
    expect(c).toBeLessThanOrEqual(0xdfff);
    expect(old.isWellFormed()).toBe(false);
  });

  test("новый хвост корректен по UTF-16", () => {
    const tail = tailByCodePoints(splitting, LIMIT);
    expect(tail.isWellFormed()).toBe(true);
  });

  test("отброшено ровно ничего лишнего — только осиротевшая половина", () => {
    const tail = tailByCodePoints(splitting, LIMIT);
    expect(tail.length).toBe(LIMIT - 1);
    expect(splitting.endsWith(tail)).toBe(true);
  });

  test("строка короче лимита возвращается целиком", () => {
    expect(tailByCodePoints("коротко", LIMIT)).toBe("коротко");
  });

  test("ровно по лимиту — без обрезки", () => {
    const s = "x".repeat(LIMIT);
    expect(tailByCodePoints(s, LIMIT)).toBe(s);
  });

  test("обработчик шлёт в чат корректный по UTF-16 текст", async () => {
    // Прямой тест хелпера мутацию «в обработчике снова голый slice» не ловит,
    // поэтому проверяем то, что реально уходит в tg.sendMessage.
    const sent: string[] = [];
    const telegram = {
      sendMessage: async (_chatId: number, text: string) => {
        sent.push(text);
        return { message_id: 1 };
      },
    } as unknown as Parameters<typeof dispatchAction>[2]["telegram"];

    const bridge = {
      isMacConnected: () => true,
      isUserAllowed: () => true,
      sendToMac: async () => ({ ok: true, code: 0, stdout: splitting, stderr: "" }),
      stopMac: async () => ({ ok: true }),
    };
    const res = await dispatchAction(
      "MAC_RUN_CLAUDE",
      {
        project: "/Users/dobropalm/programs/foo",
        prompt: "покажи вывод",
        mode: "ask",
        _userId: "42",
      },
      { agentKey: "orchestrator", chatId: TEST_CHAT, macBridge: bridge, telegram },
    );
    expect(res.ok).toBe(true);
    expect(sent.length).toBeGreaterThan(0);
    for (const text of sent) expect(text.isWellFormed()).toBe(true);
    cleanupChat(TEST_CHAT);
  });

  test("граница на целом символе ничего не сдвигает", () => {
    // Чётное число code unit'ов до границы — пара не рвётся.
    const even = "a".repeat(200) + FIRE.repeat(2000);
    const tail = tailByCodePoints(even, LIMIT);
    expect(tail.length).toBe(LIMIT);
    expect(tail.isWellFormed()).toBe(true);
  });
});
