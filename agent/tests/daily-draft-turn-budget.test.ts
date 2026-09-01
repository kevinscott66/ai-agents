import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RESEARCH_MAX_TURNS, researchPrompt } from "../tools/daily-draft";

/**
 * Юнит `delabs-daily-draft` падал каждый прогон:
 *   [daily-draft] research failed: Reached maximum number of turns (12)
 *
 * Причина не в модели. Промпт просил 3-4 статьи, в каждой 2-4 источника,
 * «которые ты открыл» — это 15-20 вызовов инструментов при бюджете в 12 ходов.
 * Задача была невыполнима арифметически, и никакой ретрай этого бы не спас.
 *
 * Отсюда два инварианта ниже. Проверять «RESEARCH_MAX_TURNS === 20» смысла нет:
 * такой тест сторожит константу, а сломалось соотношение между константой,
 * текстом промпта и таймаутом юнита. Разъехаться они могут независимо.
 */
describe("бюджет ходов ресёрча", () => {
  test("промпт называет модели тот же бюджет, что уходит в SDK", () => {
    // Если поднять maxTurns и забыть промпт, модель продолжит планировать под
    // старое число; если поправить промпт и забыть константу — оборвётся на
    // середине. Числа обязаны быть одним и тем же числом.
    expect(researchPrompt([])).toContain(String(RESEARCH_MAX_TURNS));
  });

  test("промпт не требует открывать каждый источник", () => {
    // Формулировка «(2-4 ссылки), которые ты открыл» превращала каждый источник
    // в обязательный WebFetch. Системный промпт этого не требует: URL из выдачи
    // поиска — такой же настоящий источник.
    expect(researchPrompt([])).not.toContain("которые ты открыл");
  });

  test("бюджет укладывается в TimeoutStartSec юнита", () => {
    // Упавший прогон: 4м25с на 12 ходов ≈ 22с/ход. После ресёрча идут ещё рендер
    // баннера и две ходки в Telegram — им нужен запас, поэтому ресёрчу отдаём
    // не больше трёх четвертей таймаута.
    const unit = readFileSync(
      join(import.meta.dir, "..", "..", "deploy", "systemd", "delabs-daily-draft.service"),
      "utf8",
    );
    const m = unit.match(/^TimeoutStartSec=(\d+)/m);
    expect(m).not.toBeNull();
    const timeoutSec = Number(m![1]);

    const SEC_PER_TURN = 22;
    expect(RESEARCH_MAX_TURNS * SEC_PER_TURN).toBeLessThanOrEqual(timeoutSec * 0.75);
  });

  test("бюджета хватает на объём, который просит промпт", () => {
    // 4 статьи × (1 поиск + 1 уточняющий fetch) + 2 широких поиска + финальный
    // ход с JSON. Меньше этого — снова гарантированный обрыв.
    const MIN_NEEDED = 4 * 2 + 2 + 1;
    expect(RESEARCH_MAX_TURNS).toBeGreaterThanOrEqual(MIN_NEEDED);
  });
});
