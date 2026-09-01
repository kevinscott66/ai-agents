/**
 * Аудит 2026-08-28: WebFetch показывал модели что угодно как текст.
 *
 * Тело собиралось в `Buffer.concat(chunks).toString("utf8")` и уходило в
 * промпт независимо от того, что сервер прислал. PDF, картинка, tarball,
 * gzip — всё превращалось в мусор длиной до MAX_MODEL_BODY_CHARS с тем же
 * весом в контексте, что и настоящая страница. Тип при этом объявлен в
 * `content-type`, и этот заголовок не читал никто.
 *
 * `content-encoding` — отдельный случай: запрос уходит с
 * `accept-encoding: identity`, но соблюдать это сервер не обязан, а
 * распаковки в `pinnedRequest` нет.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bodyRejectionReason, formatFetchedPage } from "../lib/sdk-web-guard.ts";

const HREF = "https://example.test/doc";

describe("что считается текстом", () => {
  test("текстовые и структурные типы проходят", () => {
    for (const t of [
      "text/html; charset=utf-8",
      "TEXT/PLAIN",
      "text/markdown",
      "application/json",
      "application/xml",
      "application/ld+json",
      "application/atom+xml",
      "application/javascript",
    ]) {
      expect(bodyRejectionReason({ "content-type": t })).toBeNull();
    }
  });

  test("бинарные типы отбиваются с указанием типа", () => {
    for (const t of ["application/pdf", "image/png", "application/octet-stream", "video/mp4"]) {
      const r = bodyRejectionReason({ "content-type": t });
      expect(r).toContain("не текстовый");
      expect(r).toContain(t);
    }
  });

  test("отсутствующий или пустой content-type поведения не меняет", () => {
    expect(bodyRejectionReason({})).toBeNull();
    expect(bodyRejectionReason({ "content-type": "" })).toBeNull();
    expect(bodyRejectionReason({ "content-type": "; charset=utf-8" })).toBeNull();
  });

  test("заголовок массивом читается по первому значению", () => {
    expect(bodyRejectionReason({ "content-type": ["application/pdf", "text/html"] })).toContain(
      "не текстовый",
    );
  });
});

describe("сжатое тело", () => {
  test("любой content-encoding кроме identity отбивается", () => {
    for (const e of ["gzip", "br", "deflate", "GZIP"]) {
      expect(bodyRejectionReason({ "content-encoding": e })).toContain("сжатым");
    }
    expect(bodyRejectionReason({ "content-encoding": "identity" })).toBeNull();
    expect(bodyRejectionReason({ "content-encoding": "" })).toBeNull();
  });

  test("сжатие проверяется раньше типа: text/html в gzip — всё равно байты", () => {
    const r = bodyRejectionReason({ "content-type": "text/html", "content-encoding": "gzip" });
    expect(r).toContain("сжатым");
  });
});

describe("вывод модели", () => {
  test("отклонённое тело не показывается и не оборачивается в фенс", () => {
    const out = formatFetchedPage(HREF, 200, "%PDF-1.7 мусор", {
      "content-type": "application/pdf",
    });
    expect(out).toContain("[тело не показано:");
    expect(out).toContain("application/pdf");
    expect(out).not.toContain("%PDF");
    expect(out).not.toContain("<<<UNTRUSTED");
    expect(out).toContain(`URL: ${HREF}`);
    expect(out).toContain("HTTP 200");
  });

  test("текстовое тело идёт прежним путём — в фенсе", () => {
    const out = formatFetchedPage(HREF, 200, "привет", { "content-type": "text/html" });
    expect(out).toContain("<<<UNTRUSTED");
    expect(out).toContain("привет");
  });

  test("вызов без заголовков остаётся совместимым", () => {
    expect(formatFetchedPage(HREF, 200, "привет")).toContain("привет");
  });

  test("guardedWebFetch передаёт заголовки ответа в форматирование", () => {
    const src = readFileSync(
      new URL("../lib/sdk-web-guard.ts", import.meta.url).pathname,
      "utf8",
    );
    const call = src.slice(src.lastIndexOf("return formatFetchedPage("));
    expect(call.slice(0, 200)).toContain("response.headers");
  });
});
