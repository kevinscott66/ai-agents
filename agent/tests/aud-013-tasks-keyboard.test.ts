/**
 * AUD-013: карточки и модальные окна задач доступны с клавиатуры.
 *
 * DOM-окружения в тестах нет, поэтому поведение ловушки фокуса проверяется
 * на чистой функции, а разметка — по исходнику.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { trapTarget, FOCUSABLE } from "../miniapp/src/lib/focus-trap.ts";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf-8");
const TASKS = read("../miniapp/src/pages/Tasks.tsx");
const DIALOG = read("../miniapp/src/components/Dialog.tsx");

describe("ловушка фокуса", () => {
  test("Tab с последнего — на первый, Shift+Tab с первого — на последний", () => {
    expect(trapTarget(3, 2, false)).toBe(0);
    expect(trapTarget(3, 0, true)).toBe(2);
  });
  test("в середине — браузер ходит сам", () => {
    expect(trapTarget(3, 1, false)).toBeNull();
    expect(trapTarget(3, 1, true)).toBeNull();
    expect(trapTarget(3, 0, false)).toBeNull();
  });
  test("фокус вне списка возвращается внутрь", () => {
    expect(trapTarget(3, -1, false)).toBe(0);
    expect(trapTarget(3, -1, true)).toBe(2);
  });
  test("без интерактивных элементов фокус держится на контейнере", () => {
    expect(trapTarget(0, -1, false)).toBe(-1);
  });
  test("отключённые элементы в обход не попадают", () => {
    expect(FOCUSABLE).toContain("button:not([disabled])");
    expect(FOCUSABLE).toContain('[tabindex]:not([tabindex="-1"])');
  });
});

describe("Dialog", () => {
  test("объявлен диалогом для скринридера", () => {
    expect(DIALOG).toContain('role="dialog"');
    expect(DIALOG).toContain('aria-modal="true"');
    expect(DIALOG).toContain("aria-labelledby={titleId}");
    expect(DIALOG).toContain("<h2 id={titleId}>");
  });
  test("Escape закрывает, если закрытие не запрещено", () => {
    expect(DIALOG).toMatch(/e\.key === "Escape"[\s\S]{0,120}if \(!closeRef\.current\.closeDisabled\) closeRef\.current\.onClose\(\)/);
  });
  test("фокус возвращается открывшему элементу", () => {
    expect(DIALOG).toContain("const opener = document.activeElement");
    expect(DIALOG).toContain("opener.focus()");
  });
});

describe("страница задач", () => {
  test("карточка открывается настоящей кнопкой", () => {
    expect(TASKS).toMatch(/<button\s+type="button"\s+className="task-open"\s+onClick=\{\(\) => openTask\(t\)\}/);
    expect(TASKS).not.toMatch(/<div[^>]*onClick=\{\(\) => openTask/);
  });
  test("обе модалки — через Dialog, голых оверлеев не осталось", () => {
    expect(TASKS).not.toContain('className="modal-overlay"');
    expect((TASKS.match(/<Dialog\b/g) ?? []).length).toBe(2);
  });
  test("отправка формы не закрывается Escape посреди запроса", () => {
    expect(TASKS).toContain("closeDisabled={nSubmitting}");
  });
  test("подписи полей связаны с полями", () => {
    for (const id of ["new-task-title", "new-task-assignee", "new-task-chat", "new-task-input"]) {
      expect(TASKS).toContain(`htmlFor="${id}"`);
      expect(TASKS).toContain(`id="${id}"`);
    }
  });
});
