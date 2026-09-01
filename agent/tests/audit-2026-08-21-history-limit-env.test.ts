/**
 * Аудит 2026-08-21: `MEMORY_HISTORY_LIMIT=` из .env.example обнулял историю.
 *
 * В orchestrator-team.ts стояло:
 *
 *   const HISTORY_LIMIT = Number(
 *     process.env.MEMORY_HISTORY_LIMIT ?? DEFAULT_MESSAGE_HISTORY_LIMIT,
 *   );
 *
 * `??` ловит только null/undefined. Переменная, объявленная и пустая, — это
 * `""`, и до дефолта дело не доходит: `Number("")` равен 0.
 *
 * А `.env.example:55` ровно так её и отдаёт:
 *
 *   MEMORY_HISTORY_LIMIT=               # Optional cap on retained history entries.
 *
 * То есть документированный путь настройки («скопируй .env.example в .env»)
 * выключал у оркестратора память о разговоре. Замер на временной базе с пятью
 * сообщениями:
 *
 *   не задан                     Number=30    строк истории: 5
 *   пустой (как в .env.example)  Number=0     строк истории: 0
 *   пробелы                      Number=0     строк истории: 0
 *   мусор                        Number=NaN   строк истории: THROW: datatype mismatch
 *   20                           Number=20    строк истории: 5
 *
 * Ноль не роняет ничего — `getRecentMessages` отдаёт `LIMIT 0`, пустой список,
 * и агент отвечает так, будто разговор начался только что. Это тише и хуже
 * падения: выглядит как «модель тупит», а не как сломанная конфигурация.
 * Мусор в переменной, наоборот, роняет каждое сообщение о `datatype mismatch`
 * — NaN уходит биндом прямо в SQLite.
 *
 * Тот же класс, что PR #560 (`MEMORY_DB_PATH=` пустой → временная БД).
 */
import { describe, test, expect, spyOn } from "bun:test";
import { parseHistoryLimit } from "../orchestrator/helpers.ts";
import { log } from "../lib/log.ts";

const DFLT = 30;

describe("parseHistoryLimit: пустое значение — это «не задано»", () => {
  test("переменной нет", () => {
    expect(parseHistoryLimit(undefined, DFLT)).toBe(DFLT);
  });

  test("объявлена пустой — как в .env.example", () => {
    expect(parseHistoryLimit("", DFLT)).toBe(DFLT);
  });

  test("одни пробелы", () => {
    expect(parseHistoryLimit("   ", DFLT)).toBe(DFLT);
  });
});

describe("parseHistoryLimit: заданное значение уважается", () => {
  test("обычное число", () => {
    expect(parseHistoryLimit("20", DFLT)).toBe(20);
  });

  test("пробелы по краям не мешают", () => {
    expect(parseHistoryLimit(" 20 ", DFLT)).toBe(20);
  });

  test("дробь отсекается вниз: LIMIT целочисленный", () => {
    expect(parseHistoryLimit("7.9", DFLT)).toBe(7);
  });
});

describe("parseHistoryLimit: негодное значение не доезжает до SQLite", () => {
  test("мусор — дефолт, а не NaN", () => {
    // NaN уходил биндом в LIMIT и ронял каждое сообщение о datatype mismatch.
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(parseHistoryLimit("abc", DFLT)).toBe(DFLT);
      expect(parseHistoryLimit("Infinity", DFLT)).toBe(DFLT);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("ноль и отрицательное — дефолт: агент без истории это не конфигурация", () => {
    // `LIMIT 0` не ошибка для SQLite, поэтому молча пропустить его нельзя:
    // получится тихо работающий агент без памяти о разговоре.
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      expect(parseHistoryLimit("0", DFLT)).toBe(DFLT);
      expect(parseHistoryLimit("-5", DFLT)).toBe(DFLT);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("негодное значение — это шум в логе, а не молчание", () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      parseHistoryLimit("abc", DFLT);
      expect(warn.mock.calls.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("годное значение лог не трогает", () => {
    const warn = spyOn(log, "warn").mockImplementation(() => {});
    try {
      parseHistoryLimit("20", DFLT);
      parseHistoryLimit("", DFLT);
      parseHistoryLimit(undefined, DFLT);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
