/**
 * Инварианты бейджей (аудит 2026-08-12, хвост в ветке редизайна).
 *
 * 1. Класс никогда не собирается из свободного текста БД — только из списка.
 * 2. «Не подтверждён» не читается как «подтверждён»: правило лингвистическое,
 *    и именно из-за него функция раньше жила двумя дословными копиями в
 *    HomeActivities и ActivitiesSection.
 */
import { describe, expect, test } from "bun:test";
import { activityBadgeClass, dropBadgeClass, dropBadgeLabel } from "./badges";

const ALLOWED = new Set([
  "badge-active",
  "badge-soon",
  "badge-ended",
  "badge-muted",
  "badge-status-ok",
  "badge-status-soon",
  "badge-status-no",
]);

describe("dropBadgeClass", () => {
  test("известные статусы", () => {
    expect(dropBadgeClass("active")).toBe("badge-active");
    expect(dropBadgeClass("soon")).toBe("badge-soon");
    expect(dropBadgeClass("ended")).toBe("badge-ended");
  });

  test("свободный TEXT из БД не попадает в class", () => {
    // Пробел в значении раньше давал произвольный набор классов, а незнакомое
    // значение — класс, которого в styles.css нет вовсе.
    for (const s of ["", " ", "active ended", "закончился", "hidden dark", "__proto__"]) {
      expect(dropBadgeClass(s)).toBe("badge-muted");
    }
  });

  test("подпись незнакомого статуса показывается как есть", () => {
    expect(dropBadgeLabel("active")).toBe("Идёт");
    expect(dropBadgeLabel("paused")).toBe("paused");
    expect(dropBadgeLabel("__proto__")).toBe("__proto__");
  });
});

describe("activityBadgeClass", () => {
  test("«не подтверждён» — это не «подтверждён»", () => {
    expect(activityBadgeClass("Подтверждён")).toBe("badge-status-ok");
    expect(activityBadgeClass("не подтверждён")).toBe("badge-status-no");
    expect(activityBadgeClass("Не подтверждён")).toBe("badge-status-no");
  });

  test("потенциальный и незнакомое", () => {
    expect(activityBadgeClass("Потенциальный")).toBe("badge-status-soon");
    expect(activityBadgeClass("")).toBe("badge-muted");
    expect(activityBadgeClass("ретродроп")).toBe("badge-muted");
  });

  test("что бы ни пришло — класс из списка", () => {
    for (const s of ["", "  ", "x y z", "Подтверждён ретродроп", "НЕ ПОТЕНЦИАЛЬНЫЙ"]) {
      expect(ALLOWED.has(activityBadgeClass(s))).toBe(true);
    }
  });
});
