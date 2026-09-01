/**
 * Аудит 2026-08-29: у картинки-документа mime сверялся точной строкой.
 *
 * Текстовой ветке это починили 2026-08-28 (`normalizeMime` в
 * `isTextDocument`), а соседняя проверка картинки осталась инлайновой
 * `/^image\//.test(mime_type)` — без флага `i` и без допуска на параметры.
 * Половина одной проверки была приведена к канону, половина нет.
 *
 * Тише всего дефект стоит при `IMAGE/PNG`: не поднимается ни `hasImage`, ни
 * `hasTextDoc` (второе — потому что `image/*` не текстовый тип), а
 * `attachmentLossNote` сверяет ровно эти два флага и потому молчит. С
 * подписью модель отвечает про файл, которого не видела; без подписи ход
 * отбрасывается целиком, и человеку не говорят ничего.
 *
 * Инвариант тот же, что у текстовой ветки: тип разбирается по RFC 9110 —
 * регистр не значим, параметры после `;` отбрасываются.
 */
import { describe, expect, test } from "bun:test";
import {
  attachmentLossNote,
  isImageDocument,
  isTextDocument,
} from "../orchestrator/message-handler.ts";

const doc = (mime: unknown) => ({ mime_type: mime, file_name: "" });

describe("картинка-документ: регистр и параметры", () => {
  test("верхний регистр больше не отбрасывает картинку", () => {
    for (const mime of ["IMAGE/PNG", "Image/Jpeg", "IMAGE/webp", "image/GIF"]) {
      expect(isImageDocument(doc(mime))).toBe(true);
    }
  });

  test("параметры после точки с запятой отбрасываются", () => {
    for (const mime of [
      "image/png; name=screenshot.png",
      "image/jpeg;charset=binary",
      " image/webp ",
      "IMAGE/PNG; name=x.png",
    ]) {
      expect(isImageDocument(doc(mime))).toBe(true);
    }
  });

  test("канонический тип работал и продолжает работать", () => {
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(isImageDocument(doc(mime))).toBe(true);
    }
  });

  test("не-картинка остаётся не-картинкой", () => {
    for (const mime of [
      "text/plain",
      "application/pdf",
      "application/json; charset=utf-8",
      "video/mp4",
      "",
    ]) {
      expect(isImageDocument(doc(mime))).toBe(false);
    }
  });

  test("«image» без подтипа и похожие строки не проходят", () => {
    // startsWith("image/") — граница именно по слэшу, иначе сюда пролезли бы
    // `imagestore/...` и прочие типы, которые к картинке отношения не имеют.
    for (const mime of ["image", "imagestore/blob", "x-image/png", "notimage/png"]) {
      expect(isImageDocument(doc(mime))).toBe(false);
    }
  });

  test("мусор вместо документа и вместо типа не роняет проверку", () => {
    expect(isImageDocument(undefined)).toBe(false);
    expect(isImageDocument(null)).toBe(false);
    expect(isImageDocument("image/png")).toBe(false);
    expect(isImageDocument(42)).toBe(false);
    expect(isImageDocument({})).toBe(false);
    expect(isImageDocument(doc(123))).toBe(false);
    expect(isImageDocument(doc(null))).toBe(false);
  });
});

describe("вложение не пропадает молча", () => {
  /** Ровно то, как хендлер считает флаги: doc-картинка исключает textDoc. */
  function flags(mime: unknown) {
    const d = doc(mime);
    const hasImage = isImageDocument(d);
    return { hasImage, hasTextDoc: !hasImage && isTextDocument(d) };
  }

  test("IMAGE/PNG раньше не поднимал ни одного флага — теперь поднимает", () => {
    const f = flags("IMAGE/PNG");
    expect(f.hasImage).toBe(true);
    expect(f.hasTextDoc).toBe(false);

    // Значит и предупреждение о потере теперь есть кому выдать.
    expect(
      attachmentLossNote({ ...f, imagesAttached: 0, documentsAttached: 0 }),
    ).toContain("картинка");
  });

  test("доехавшая картинка предупреждения не вызывает", () => {
    const f = flags("IMAGE/PNG");
    expect(
      attachmentLossNote({ ...f, imagesAttached: 1, documentsAttached: 0 }),
    ).toBeNull();
  });

  test("текстовый документ по-прежнему идёт своей веткой", () => {
    const f = flags("application/json; charset=utf-8");
    expect(f.hasImage).toBe(false);
    expect(f.hasTextDoc).toBe(true);
  });
});
