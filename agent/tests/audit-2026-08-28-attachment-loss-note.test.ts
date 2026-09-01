/**
 * Аудит 2026-08-28: маркер вложения ставился по наличию, а не по доставке.
 *
 * Текст хода при пустой подписи собирается из ФАКТА вложения в апдейте:
 * `[image]` либо `[файл: имя]`. Ставится он до скачивания, а между ним и
 * моделью пять веток, каждая из которых роняет вложение молча, только в
 * log.info: mime не в аллоулисте, заявленный размер выше потолка,
 * фактический размер выше потолка, документ выше 1 МБ, любой сбой скачивания.
 *
 * Воспроизводится тривиально: .log на 2 МБ без подписи. Модели сказано
 * «файл: app.log», документов ноль — и она отвечает про файл, которого не
 * видела. Человеку не сказано ничего, он видит осмысленный ответ про своё
 * вложение. Молчаливая подмена входа хуже отказа: отказ хотя бы виден.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { attachmentLossNote } from "../orchestrator/message-handler.ts";

const ok = { hasImage: false, hasTextDoc: false, imagesAttached: 0, documentsAttached: 0 };

describe("attachmentLossNote", () => {
  test("вложения не было — молчим", () => {
    expect(attachmentLossNote(ok)).toBeNull();
  });

  test("всё доехало — молчим", () => {
    expect(
      attachmentLossNote({ ...ok, hasImage: true, imagesAttached: 1 }),
    ).toBeNull();
    expect(
      attachmentLossNote({ ...ok, hasTextDoc: true, documentsAttached: 1, fileName: "a.log" }),
    ).toBeNull();
  });

  test("картинка потерялась — сказано словами", () => {
    const note = attachmentLossNote({ ...ok, hasImage: true, imagesAttached: 0 });
    expect(note).toContain("НЕ приложен");
    expect(note).toContain("картинка");
  });

  test("файл потерялся — назван по имени", () => {
    const note = attachmentLossNote({
      ...ok,
      hasTextDoc: true,
      documentsAttached: 0,
      fileName: "app.log",
    });
    expect(note).toContain("app.log");
  });

  test("имени файла нет — обходимся без него, без undefined в тексте", () => {
    for (const fileName of [undefined, "", "   "]) {
      const note = attachmentLossNote({ ...ok, hasTextDoc: true, documentsAttached: 0, fileName });
      expect(note).toContain("файл");
      expect(note).not.toContain("undefined");
      expect(note).not.toContain("«»");
    }
  });

  test("модели прямо сказано не делать вид, что видит содержимое", () => {
    const note = attachmentLossNote({ ...ok, hasImage: true, imagesAttached: 0 }) ?? "";
    expect(note.toLowerCase()).toContain("не отвечай");
    expect(note.toLowerCase()).toContain("заново");
  });

  test("потерялось и то и другое — перечислено обоё", () => {
    const note =
      attachmentLossNote({
        hasImage: true,
        hasTextDoc: true,
        imagesAttached: 0,
        documentsAttached: 0,
        fileName: "a.csv",
      }) ?? "";
    expect(note).toContain("картинка");
    expect(note).toContain("a.csv");
  });

  test("частичная удача картинок потерей не считается", () => {
    expect(
      attachmentLossNote({ ...ok, hasImage: true, imagesAttached: 2 }),
    ).toBeNull();
  });
});

describe("применение", () => {
  const SRC = readFileSync(
    new URL("../orchestrator/message-handler.ts", import.meta.url),
    "utf8",
  );

  test("проверка стоит ПОСЛЕ обоих блоков скачивания", () => {
    const img = SRC.indexOf("[image][${def.key}] attached");
    const doc = SRC.indexOf("[file][${def.key}] attached");
    const call = SRC.indexOf("const lossNote = attachmentLossNote({");
    expect(img).toBeGreaterThan(0);
    expect(doc).toBeGreaterThan(img);
    expect(call).toBeGreaterThan(doc);
  });

  test("считаются реально приложенные, а не флаги наличия", () => {
    const from = SRC.indexOf("const lossNote = attachmentLossNote({");
    const region = SRC.slice(from, SRC.indexOf("});", from));
    expect(region).toContain("imagesAttached: inputImages.length");
    expect(region).toContain("documentsAttached: inputDocuments.length");
  });

  test("до вызова доходит и то, что стоит ПЕРЕД ним по ходу выполнения", () => {
    // Ход дальше идёт в runWithTools; заметка обязана попасть в messages до него.
    const call = SRC.indexOf("const lossNote = attachmentLossNote({");
    const tools = SRC.indexOf("shouldAllowTools(", call);
    expect(tools).toBeGreaterThan(call);
  });
});
