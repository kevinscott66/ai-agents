/**
 * Статус задачи, которого нет в карте лейблов, доезжает до экрана латиницей.
 *
 * `label()` при промахе возвращает сам ключ (miniapp/src/lib/labels.ts:75-78) —
 * молча, без предупреждения. В `TASK_STATUS_LABELS` не было `awaiting_review`,
 * хотя это полноценный статус FSM: `TASK_TRANSITIONS.running` его содержит,
 * `REQUEST_REVIEW` его выставляет (lib/dispatch/tasks.ts:175), а `Tasks.tsx:19`
 * держит его в списке фильтра. То есть на экране Tasks он был виден в трёх
 * местах сразу — в выпадающем списке фильтра (`:249`), в бейдже строки (`:290`)
 * и в карточке (`:321`) — английским словом среди русских подписей. В
 * подтверждении перехода (`:183`) получалось «Отметить «X» как
 * «awaiting_review»?».
 *
 * Проверка идёт не по списку литералов, а по `TASK_TRANSITIONS` — единственному
 * источнику правды о наборе статусов, который к тому же браузеро-безопасен и
 * уже импортируется самой страницей. Так следующий добавленный статус ломает
 * тест, а не вёрстку.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { TASK_TRANSITIONS } from "../lib/task-fsm.ts";
import { TASK_STATUSES } from "../lib/types.ts";
import { TASK_STATUS_LABELS, label } from "../miniapp/src/lib/labels.ts";

const FSM_STATUSES = Object.keys(TASK_TRANSITIONS);

describe("TASK_STATUS_LABELS покрывает FSM", () => {
  test("у каждого статуса FSM есть лейбл", () => {
    const missing = FSM_STATUSES.filter((s) => !(s in TASK_STATUS_LABELS));
    expect(missing).toEqual([]);
  });

  test("label() ни по одному статусу не отдаёт сырой ключ", () => {
    const raw = FSM_STATUSES.filter((s) => label(TASK_STATUS_LABELS, s) === s);
    expect(raw).toEqual([]);
  });

  test("лейблы русские — латиницы в подписях нет", () => {
    for (const s of FSM_STATUSES) {
      const text = label(TASK_STATUS_LABELS, s);
      expect(text).toMatch(/[а-яё]/i);
      expect(text).not.toMatch(/[a-z]/i);
    }
  });

  test("awaiting_review переведён явно", () => {
    expect(TASK_STATUS_LABELS.awaiting_review).toBe("на ревью");
  });

  test("awaiting_review и awaiting_approval — разные подписи", () => {
    // Пара «ревью / аппрув» — единственная, где промах перевода не заметен:
    // оба статуса про ожидание человека, и одинаковая подпись скрыла бы, что
    // задача ждёт не того. Переходы у них разные (FSM: awaiting_review →
    // running | done, awaiting_approval → running | cancelled).
    expect(TASK_STATUS_LABELS.awaiting_review).not.toBe(
      TASK_STATUS_LABELS.awaiting_approval,
    );
  });

  test("серверный TASK_STATUSES и FSM описывают один набор", () => {
    // Две копии списка живут в разных файлах (types.ts — для сервера,
    // task-fsm.ts — общий и браузеро-безопасный). Если они разойдутся,
    // проверка выше начнёт мерить не тот набор и станет ложно-зелёной.
    const server: string[] = [...TASK_STATUSES];
    expect(server.sort()).toEqual([...FSM_STATUSES].sort());
  });
});

describe("страница Tasks берёт подписи из карты", () => {
  const SRC = readFileSync(
    new URL("../miniapp/src/pages/Tasks.tsx", import.meta.url),
    "utf8",
  );

  test("статус не выводится в текст напрямую, минуя label()", () => {
    // `${t.status}` внутри className бейджа — законен, это имя класса, а не
    // текст. Ищем только JSX-вывод `{t.status}` без доллара.
    expect(SRC).not.toMatch(/(?<!\$)\{\s*(t|task|selected)\.status\s*\}/);
  });

  test("фильтр статусов переводит подписи", () => {
    expect(SRC).toContain("label(TASK_STATUS_LABELS, s)");
  });

  test("кнопка перехода подписана по-русски", () => {
    // Тот же дефект, что и в карте лейблов, только источник другой: кнопки
    // строятся прямо из FSM (`NEXT_STATUS[selected.status].map`), и статус
    // печатался сырым — «→ awaiting_review». Карта тут не при чём, перевод
    // нужно звать явно.
    expect(SRC).toContain("`→ ${label(TASK_STATUS_LABELS, next)}`");
    expect(SRC).not.toContain("`→ ${next}`");
  });

  test("тост о смене статуса подписан по-русски", () => {
    expect(SRC).toContain("Задача → ${label(TASK_STATUS_LABELS, next)}");
    expect(SRC).not.toContain("Задача → ${next}");
  });
});
