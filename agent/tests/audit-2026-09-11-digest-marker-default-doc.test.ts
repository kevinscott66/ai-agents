/**
 * Аудит 2026-09-11: докстроки lib/digest.ts обещали дефолт, снесённый год
 * назад — и обещали именно тот, который был дефектом.
 *
 * 2026-08-08 дефолтом маркера был относительный `.digest-last`. Он ложился в
 * `WorkingDirectory` юнита, а корень под `ProtectSystem=strict` смонтирован
 * read-only: запись давала EROFS, провал глотался в `log.warn`, и каждый тик
 * заново решал «сегодня ещё не постили» — до ~216 копий дайджеста в чат за
 * сутки. Разбор целиком — в докблоке `_defaultMarkerPath`; починка положила
 * маркер рядом с БД.
 *
 * Две докстроки про это не узнали: шапка модуля и комментарий у поля
 * `markerPath`. Обе продолжали писать «default `.digest-last`». Это не
 * стилистика: `markerPath` — публичная опция, и её докстрока — единственное,
 * что читает вызывающий, решая, передавать путь или положиться на дефолт.
 * Она отправляла его ровно в ту точку, из которой уходили.
 *
 * Сторож проверяет два утверждения и ничего больше:
 *   1. ни одна докстрока не называет `.digest-last` дефолтом;
 *   2. обе отсылают к `_defaultMarkerPath`, где лежит разбор.
 * Сам путь проверяет `digest-marker-failure.test.ts` («дефолт не привязан к
 * cwd») — здесь его не дублируем.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "lib", "digest.ts"), "utf8");

/** Докблок модуля — всё до первого `import`. */
const HEADER = SRC.slice(0, SRC.indexOf("import "));

/** Докстрока поля `markerPath` — комментарий прямо над ним. */
const MARKER_DOC = (() => {
  const at = SRC.indexOf("markerPath?: string;");
  expect(at).toBeGreaterThan(0);
  const from = SRC.lastIndexOf("/**", at);
  return SRC.slice(from, at);
})();

describe("докстроки digest.ts не обещают снесённый дефолт маркера", () => {
  test("шапка модуля не называет `.digest-last` дефолтом", () => {
    expect(/default\s+`?\.digest-last/i.test(HEADER)).toBe(false);
  });

  test("докстрока markerPath не называет `.digest-last` дефолтом", () => {
    expect(/Default\s+`?\.digest-last/i.test(MARKER_DOC)).toBe(false);
  });

  test("обе отсылают к _defaultMarkerPath", () => {
    expect(HEADER).toContain("_defaultMarkerPath");
    expect(MARKER_DOC).toContain("_defaultMarkerPath");
  });

  test("символ, на который они ссылаются, существует", () => {
    expect(SRC).toContain("export function _defaultMarkerPath(");
  });
});
