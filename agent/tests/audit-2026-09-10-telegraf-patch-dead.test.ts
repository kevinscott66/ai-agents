/**
 * Аудит 2026-09-10: патч `redactToken` в telegraf-patch.ts не выполнялся ни разу.
 *
 * Полсотни строк на входе процесса (файл импортируется первой строкой
 * `orchestrator-team.ts`) читались как «мы аккуратно обходим особенность Bun».
 * На деле обходить было нечего и нечем:
 *
 *  1. `client.redactToken` — undefined. Модуль
 *     `telegraf/lib/core/network/client.js` объявляет функцию локально и
 *     экспортирует только `default`. Условие `if (orig && …)` не выполнялось, и
 *     патч молча уходил ни с чем — в лог при таком исходе не писалось НИЧЕГО:
 *     строка была и на успех, и на исключение, но не на «метода нет».
 *
 *  2. `error.message` под Bun 1.3.14 записываем. Посылка старой шапки — «у Bun
 *     .message часто readonly» — не воспроизводится ни на обычном `Error`, ни
 *     на `SyntaxError`, ни на `TypeError` из `URL`.
 *
 * Тест — канарейка: если telegraf когда-нибудь начнёт экспортировать
 * `redactToken` или Bun сделает `.message` неизменяемым, посылки станут ложными
 * и файл покраснеет — тогда решение «удалить патч» пересматривают осознанно, а
 * не обнаруживают отсутствие защиты в проде.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

describe("посылка 1: патчить было нечего", () => {
  test("telegraf не экспортирует redactToken", () => {
    // Через `require.resolve("telegraf")`, а не по `process.cwd()`: карта
    // `exports` пакета закрывает прямой доступ к глубокому подпути, а cwd у
    // теста и у боевого процесса не обязан совпадать — старый код брал именно
    // cwd, и это была вторая причина, по которой патч мог не найти модуль.
    const client = join(
      dirname(require.resolve("telegraf")),
      "core",
      "network",
      "client.js",
    );
    const mod = require(client);
    expect(Object.keys(mod)).toEqual(["default"]);
    expect(mod.redactToken).toBeUndefined();
  });
});

describe("посылка 2: патчить было не нужно", () => {
  // Оффлайн и детерминированно: сетевая ошибка сюда не нужна, дескриптор у всех
  // Error-подобных объектов Bun задаёт одинаково.
  const cases: Array<[string, () => Error]> = [
    ["обычный Error", () => new Error("boom")],
    [
      "SyntaxError из JSON.parse",
      () => {
        try {
          JSON.parse("{");
          throw new Error("JSON.parse должен был бросить");
        } catch (e) {
          return e as Error;
        }
      },
    ],
    [
      "TypeError из URL",
      () => {
        try {
          new URL("::");
          throw new Error("new URL должен был бросить");
        } catch (e) {
          return e as Error;
        }
      },
    ],
  ];

  for (const [name, make] of cases) {
    test(`${name}: .message записываем присваиванием`, () => {
      const err = make();
      const d = Object.getOwnPropertyDescriptor(err, "message");
      expect(d?.writable).toBe(true);
      err.message = "переписано";
      expect(err.message).toBe("переписано");
    });
  }
});

describe("патча в исходнике больше нет", () => {
  const SRC = readFileSync(
    new URL("../lib/telegraf-patch.ts", import.meta.url),
    "utf8",
  );
  const CODE = SRC.split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  test("модуль telegraf не загружается по пути из cwd", () => {
    // Строка `node_modules/telegraf/` сама по себе в файле осталась — это кадр
    // стека в `TELEGRAF_FRAMES`, к загрузке она отношения не имеет. Ушло
    // именно чтение файла клиента.
    expect(CODE).not.toContain("core/network/client.js");
    expect(CODE).not.toContain("process.cwd()");
  });

  test("присваивания в чужой модуль не осталось", () => {
    expect(CODE).not.toContain("client.redactToken");
    expect(CODE).not.toContain("__patched");
  });

  test("а обработчики верхнего уровня остались на месте", () => {
    expect(CODE).toContain('process.on("uncaughtException"');
    expect(CODE).toContain('process.on("unhandledRejection"');
  });
});
