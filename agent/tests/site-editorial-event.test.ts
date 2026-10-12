import { describe, expect, test } from "bun:test";
import { factCheckPrompt, verdictFrom, type Checkable } from "../lib/fact-check.ts";

const article: Checkable = {
  title: "Публикация в X сообщила о выходе RSGP на Base",
  summary: "Сторонний аккаунт написал, что токен появится на Base; подробностей нет.",
  body: "Команда не подтвердила запуск, вайтлист, дату или контракт.",
  items: [{ text: "Пост в X", url: "https://x.com/cyberpunk/status/2108576240601047358" }],
  requireEvent: true,
};
const opened = [article.items![0].url];

describe("проверка повода для автоматической публикации", () => {
  test("пересказ стороннего прогноза без события блокируется даже без ложного утверждения", () => {
    const verdict = verdictFrom({ problems: [], sources_opened: opened, event_supported: false }, [], article);
    expect(verdict.problems.some((p) => p.severity === "block" && p.issue.includes("подтверждённого события"))).toBe(true);
  });

  test("отсутствующее поле или неподтверждённая ссылка не считаются согласием", () => {
    expect(verdictFrom({ problems: [], sources_opened: opened }, [], article).problems.some((p) => p.severity === "block")).toBe(true);
    expect(verdictFrom({ problems: [], sources_opened: opened, event_supported: true, event_evidence_url: "https://example.com/unopened" }, [], article).problems.some((p) => p.severity === "block")).toBe(true);
  });

  test("проверенное событие с открытым источником проходит", () => {
    const verdict = verdictFrom({ problems: [], sources_opened: opened, event_supported: true, event_evidence_url: opened[0] }, [], article);
    expect(verdict.problems).toEqual([]);
    expect(factCheckPrompt(article)).toContain("ПОВОД ДЛЯ ПУБЛИКАЦИИ");
  });

  test("для редакторской проверки активности новый критерий не применяется", () => {
    const verdict = verdictFrom({ problems: [], sources_opened: opened }, [], { ...article, requireEvent: false });
    expect(verdict.problems).toEqual([]);
  });
});
