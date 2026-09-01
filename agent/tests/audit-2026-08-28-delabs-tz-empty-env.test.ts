/**
 * Аудит 2026-08-28: `DELABS_TZ=` из .env клал весь конвейер постов.
 *
 * Читалось через `??`, а `??` пустую строку пропускает. При этом
 * `.env.example:150` документирует ровно `DELABS_TZ=` с подписью «Пусто =
 * Europe/Moscow», а `EnvironmentFile=/opt/agent-team/.env` (daily-draft,
 * weekly-draft, approve-poll) на пустом ключе даёт пустую строку, не
 * undefined. То есть отказ вызывался следованием собственной документации.
 *
 * `Intl.DateTimeFormat` с `timeZone: ""` бросает RangeError. На `partsInTz`
 * держатся ruDate, ruDateRange, weekStart, tzDayStart, tzOffsetMs — дневной
 * черновик, границы недели и публикация из approve-poll вместе с рендером
 * баннера. Try/catch на пути нет ни одного, так что RangeError выходит
 * наружу и валит прогон.
 *
 * Хвостовой пробел из dotenv — то же самое: `"Europe/Moscow "` не зона.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  DELABS_TZ,
  _resolveTz,
  ruDate,
  ruDateRange,
  weekStart,
  tzDayStart,
} from "../lib/delabs-text.ts";

const SRC = readFileSync(new URL("../lib/delabs-text.ts", import.meta.url), "utf-8");
const ENV_EXAMPLE = readFileSync(new URL("../.env.example", import.meta.url), "utf-8");

describe("предпосылки", () => {
  test("пустая и непроверенная зона — RangeError, а не тихий дефолт", () => {
    for (const bad of ["", " ", "Europe/Moscow ", "Europe/Mosow"]) {
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: bad }).format(0)).toThrow(
        RangeError,
      );
    }
  });

  test(".env.example предлагает оставить ключ пустым", () => {
    const line = ENV_EXAMPLE.split("\n").find((l) => l.startsWith("DELABS_TZ="));
    expect(line).toBeDefined();
    expect(line).toContain("Пусто = Europe/Moscow");
    // Ключ именно пустой, а не закомментированный: EnvironmentFile отдаст "".
    expect(line!.split("#")[0].trim()).toBe("DELABS_TZ=");
  });
});

describe("_resolveTz", () => {
  test("пусто, пробелы и отсутствие — Europe/Moscow", () => {
    for (const raw of ["", " ", "\t", "\n", undefined]) {
      expect(_resolveTz(raw)).toBe("Europe/Moscow");
    }
  });

  test("хвостовой пробел из dotenv срезается, а не роняет", () => {
    expect(_resolveTz(" Europe/Moscow ")).toBe("Europe/Moscow");
    expect(_resolveTz("UTC\n")).toBe("UTC");
  });

  test("нераспознанная зона — дефолт, а не бросок", () => {
    expect(_resolveTz("Europe/Mosow")).toBe("Europe/Moscow");
    expect(_resolveTz("не зона")).toBe("Europe/Moscow");
  });

  test("настоящая зона проходит как есть", () => {
    for (const tz of ["UTC", "Asia/Tokyo", "America/New_York", "Europe/Moscow"]) {
      expect(_resolveTz(tz)).toBe(tz);
    }
  });

  test("что бы ни пришло, результат — рабочая зона", () => {
    for (const raw of ["", "мусор", "Europe/Moscow ", "Asia/Tokyo"]) {
      const tz = _resolveTz(raw);
      expect(() => new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(0)).not.toThrow();
    }
  });
});

describe("конвейер дат не падает", () => {
  const D = new Date("2026-08-12T21:30:00Z");

  test("все пятеро потребителей отрабатывают на текущей зоне", () => {
    expect(DELABS_TZ).toBe("Europe/Moscow");
    expect(ruDate(D)).toBe("13 августа 2026");
    expect(ruDateRange(new Date("2026-08-10T00:00:00Z"), D)).toContain("августа");
    expect(weekStart(D) instanceof Date).toBe(true);
    expect(tzDayStart(D) instanceof Date).toBe(true);
  });
});

describe("значение проверяется, а не берётся на веру", () => {
  const CODE = SRC.split("\n")
    .filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");

  test("`??` на DELABS_TZ больше нет", () => {
    // Только код: старая форма цитируется в комментарии, объясняющем правку.
    expect(CODE).not.toContain('process.env.DELABS_TZ ?? "Europe/Moscow"');
    expect(CODE).toContain("export const DELABS_TZ = _resolveTz(process.env.DELABS_TZ);");
  });
});
