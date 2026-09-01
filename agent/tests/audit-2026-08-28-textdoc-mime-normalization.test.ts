/**
 * Аудит 2026-08-28: аллоулист mime сверялся точной строкой, соседняя проверка — нет.
 *
 * `isTextDocument` начинается с `/^text\//i` (регистр не важен), а следом идёт
 * `TEXT_DOC_MIME.has(mime)` — точное совпадение. Асимметрия внутри одной
 * функции, и она стоит файлов: RFC 9110 разрешает параметры, поэтому
 * `application/json; charset=utf-8` (обычная строка от почтового клиента,
 * архиватора, экспорта из веба) в Set не попадает вовсе.
 *
 * Промах не виден никому. Расширение спасает, только когда оно есть и
 * знакомо, а `dump`, `payload`, `export` без точки — нормальные имена
 * выгрузок. При промахе документ не скачивается, и `attachmentLossNote` тоже
 * молчит: она сверяет `hasTextDoc`, посчитанный этой же функцией. Человек
 * прислал файл, в контекст не попало ничего, и об этом не сказано ни модели,
 * ни человеку.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { attachmentLossNote, isTextDocument } from "../orchestrator/message-handler.ts";

const SRC = readFileSync(new URL("../orchestrator/message-handler.ts", import.meta.url), "utf-8");

const doc = (mime: string, name = "") => ({ mime_type: mime, file_name: name });

describe("тип с параметрами", () => {
  test("charset у аллоулиста больше не отбрасывает файл", () => {
    for (const mime of [
      "application/json; charset=utf-8",
      "application/json;charset=utf-8",
      "application/xml; charset=windows-1251",
      "application/x-yaml; charset=utf-8",
    ]) {
      expect(isTextDocument(doc(mime))).toBe(true);
    }
  });

  test("charset у text/* работал и продолжает работать", () => {
    expect(isTextDocument(doc("text/plain; charset=utf-8"))).toBe(true);
    expect(isTextDocument(doc("text/markdown;charset=utf-8"))).toBe(true);
  });
});

describe("регистр", () => {
  test("верхний регистр в аллоулисте — валидный тип", () => {
    for (const mime of ["APPLICATION/JSON", "Application/Json", "application/JSON"]) {
      expect(isTextDocument(doc(mime))).toBe(true);
    }
  });

  test("верхний регистр в text/* — как и раньше", () => {
    expect(isTextDocument(doc("TEXT/PLAIN"))).toBe(true);
  });
});

describe("пробелы", () => {
  test("обрамляющие пробелы не мешают", () => {
    expect(isTextDocument(doc("  application/json  "))).toBe(true);
    expect(isTextDocument(doc("application/json ; charset=utf-8"))).toBe(true);
  });
});

describe("что не должно измениться", () => {
  test("простой аллоулист без украшений", () => {
    for (const mime of [
      "application/json",
      "application/xml",
      "application/x-yaml",
      "application/yaml",
      "application/javascript",
      "application/typescript",
      "application/x-sh",
      "application/csv",
    ]) {
      expect(isTextDocument(doc(mime))).toBe(true);
    }
  });

  test("бинарь остаётся бинарём", () => {
    for (const mime of [
      "application/pdf",
      "application/zip",
      "image/png",
      "application/octet-stream",
      "application/vnd.ms-excel",
      "notapplication/json",
      "application/jsonx",
    ]) {
      expect(isTextDocument(doc(mime))).toBe(false);
    }
  });

  test("подстрока text/ не в начале не проходит", () => {
    expect(isTextDocument(doc("application/text/plain"))).toBe(false);
    expect(isTextDocument(doc("xtext/plain"))).toBe(false);
  });

  test("имя файла спасает, когда тип не узнан", () => {
    expect(isTextDocument(doc("application/octet-stream", "report.log"))).toBe(true);
    expect(isTextDocument(doc("", "notes.MD"))).toBe(true);
  });

  test("не объект и не строковый mime", () => {
    expect(isTextDocument(null)).toBe(false);
    expect(isTextDocument(undefined)).toBe(false);
    expect(isTextDocument("application/json")).toBe(false);
    expect(isTextDocument({ mime_type: 42 })).toBe(false);
    expect(isTextDocument({})).toBe(false);
  });
});

describe("цена промаха", () => {
  test("имя без знакомого расширения — единственная защита была в типе", () => {
    // Именно этот случай и терялся молча: типа в Set нет из-за параметра,
    // расширения нет вовсе.
    expect(isTextDocument(doc("application/json; charset=utf-8", "export"))).toBe(true);
    expect(isTextDocument(doc("application/octet-stream", "export"))).toBe(false);
  });

  test("нераспознанный документ не даёт даже оговорки про потерю", () => {
    // hasTextDoc считается той же функцией: false → нота молчит.
    const hasTextDoc = isTextDocument(doc("application/octet-stream", "export"));
    expect(hasTextDoc).toBe(false);
    expect(
      attachmentLossNote({
        hasImage: false,
        hasTextDoc,
        imagesAttached: 0,
        documentsAttached: 0,
        fileName: "export",
      }),
    ).toBeNull();
  });
});

describe("применение", () => {
  test("нормализация одна на обе проверки", () => {
    // Сравниваем построчно: провал `toContain` на целом файле вываливает его
    // весь в транскрипт (урок PR #813).
    const lines = SRC.split("\n").filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
    const has = (needle: string) => lines.some((l) => l.includes(needle));
    expect(has("const mime = normalizeMime(doc.mime_type);")).toBe(true);
    expect(has('if (mime.startsWith("text/")) return true;')).toBe(true);
    expect(has("if (TEXT_DOC_MIME.has(mime)) return true;")).toBe(true);
    // Точное сравнение сырой строки не должно вернуться.
    expect(lines.filter((l) => l.includes("test(mime)"))).toEqual([]);
  });
});
