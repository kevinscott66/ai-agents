/**
 * Аудит 2026-08-28: единственная точка чтения MTProto-креденшлов ничего о них
 * не проверяла.
 *
 * `requireTelegramApiCredentials` — общий вход для userbot, login-userbot,
 * join-group, list-dialogs и send-test, то есть другого места для проверки
 * формы просто нет. При этом:
 *
 *   - `api_hash` брался из env как есть. `"   "` истинно, поэтому проверка на
 *     пустоту его пропускала; хвостовой `\n` из EnvironmentFile= доезжал до
 *     MTProto и возвращался невнятным отказом авторизации;
 *   - `api_id` проверялся `Number.isInteger` ПОСЛЕ `Number()`, а `Number()`
 *     принимает не только десятичную запись. `1e21` — целое по этой проверке,
 *     хотя в 32-битном TL-поле такого числа нет; `0x1E240` молча становился
 *     123456, то есть чужим api_id, а не отказом.
 *
 * Проверяем и то, что сообщения об ошибках не выносят сам хэш наружу.
 */
import { describe, expect, test } from "bun:test";
import { requireTelegramApiCredentials } from "../lib/telegram-credentials.ts";

const GOOD_HASH = "0123456789abcdef0123456789abcdef";

function withEnv<T>(id: string | undefined, hash: string | undefined, fn: () => T): T {
  const prevId = process.env.TELEGRAM_API_ID;
  const prevHash = process.env.TELEGRAM_API_HASH;
  try {
    if (id === undefined) delete process.env.TELEGRAM_API_ID;
    else process.env.TELEGRAM_API_ID = id;
    if (hash === undefined) delete process.env.TELEGRAM_API_HASH;
    else process.env.TELEGRAM_API_HASH = hash;
    return fn();
  } finally {
    // Без восстановления env течёт в соседние файлы: bun гоняет каталог одним
    // процессом (CLAUDE.md §3.8 п.7).
    if (prevId === undefined) delete process.env.TELEGRAM_API_ID;
    else process.env.TELEGRAM_API_ID = prevId;
    if (prevHash === undefined) delete process.env.TELEGRAM_API_HASH;
    else process.env.TELEGRAM_API_HASH = prevHash;
  }
}

describe("api_id: запись, а не только значение", () => {
  test("экспоненциальная запись больше не проходит за целое", () => {
    // `Number.isInteger(1e21) === true` — ровно та дыра, из-за которой значение
    // уезжало дальше.
    expect(Number.isInteger(1e21)).toBe(true);
    withEnv("1e21", GOOD_HASH, () => {
      expect(() => requireTelegramApiCredentials()).toThrow(/decimal notation/);
    });
  });

  test("шестнадцатеричная запись отвергается, а не переводится в другое число", () => {
    expect(Number("0x1E240")).toBe(123456);
    withEnv("0x1E240", GOOD_HASH, () => {
      expect(() => requireTelegramApiCredentials()).toThrow(/decimal notation/);
    });
  });

  test("знак, дробь, пустое и мусор отвергаются", () => {
    for (const bad of ["+123", "-123", "123.5", "1_000", "12 34", "abc", "", "   "]) {
      withEnv(bad, GOOD_HASH, () => {
        expect(() => requireTelegramApiCredentials()).toThrow();
      });
    }
  });

  test("значение сверх 32-битного поля отвергается", () => {
    withEnv("2147483648", GOOD_HASH, () => {
      expect(() => requireTelegramApiCredentials()).toThrow(/2147483647/);
    });
    withEnv("99999999999999999999999", GOOD_HASH, () => {
      expect(() => requireTelegramApiCredentials()).toThrow(/2147483647/);
    });
  });

  test("рабочие значения и границы проходят", () => {
    withEnv("1234567", GOOD_HASH, () => {
      expect(requireTelegramApiCredentials().apiId).toBe(1234567);
    });
    withEnv("2147483647", GOOD_HASH, () => {
      expect(requireTelegramApiCredentials().apiId).toBe(2147483647);
    });
  });

  test("хвостовые пробелы из EnvironmentFile= не мешают", () => {
    withEnv(" 1234567\n", GOOD_HASH, () => {
      expect(requireTelegramApiCredentials().apiId).toBe(1234567);
    });
  });
});

describe("api_hash: форма", () => {
  test("пробельная строка больше не считается заданной", () => {
    // `"   "` истинно — старая проверка `!apiHash` его пропускала.
    expect(Boolean("   ")).toBe(true);
    withEnv("1234567", "   ", () => {
      expect(() => requireTelegramApiCredentials()).toThrow(/must be set/);
    });
  });

  test("хвостовой перевод строки срезается, а не уезжает в MTProto", () => {
    withEnv("1234567", `  ${GOOD_HASH}\n`, () => {
      expect(requireTelegramApiCredentials().apiHash).toBe(GOOD_HASH);
    });
  });

  test("не 32 hex-знака — отказ на старте", () => {
    for (const bad of [
      "0123456789abcdef0123456789abcde",
      "0123456789abcdef0123456789abcdef0",
      "0123456789abcdef0123456789abcdeg",
      "0123456789abcdef 0123456789abcde",
    ]) {
      withEnv("1234567", bad, () => {
        expect(() => requireTelegramApiCredentials()).toThrow(/32 hex/);
      });
    }
  });

  test("верхний регистр допустим", () => {
    const upper = GOOD_HASH.toUpperCase();
    withEnv("1234567", upper, () => {
      expect(requireTelegramApiCredentials().apiHash).toBe(upper);
    });
  });

  test("текст ошибки не содержит сам хэш — только его длину", () => {
    const secret = "деадбифдеадбифдеадбифдеадбифдеад";
    withEnv("1234567", secret, () => {
      let msg = "";
      try {
        requireTelegramApiCredentials();
      } catch (e) {
        msg = String((e as Error).message);
      }
      expect(msg).toContain("32 hex");
      expect(msg).not.toContain(secret);
      expect(msg).toContain("32 characters");
    });
  });
});

describe("отсутствие значений по-прежнему падает громко", () => {
  test("нет ни одного", () => {
    withEnv(undefined, undefined, () => {
      expect(() => requireTelegramApiCredentials()).toThrow(/must be set/);
    });
  });

  test("есть только хэш", () => {
    withEnv(undefined, GOOD_HASH, () => {
      expect(() => requireTelegramApiCredentials()).toThrow(/must be set/);
    });
  });
});
