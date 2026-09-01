/**
 * Аудит 2026-08-11: 11 из 12 системных промптов содержали исходник функции
 * вместо текста.
 *
 * `STAGE_NOTE` и `TONE` — это функции (`() => t('characters.tone')`, ленивые
 * ради i18n). Orchestrator подставлял их как `${STAGE_NOTE()}`, а остальные
 * одиннадцать ролей — как `${STAGE_NOTE} ${TONE}`. Шаблонная строка в этом
 * случае не падает и не подсвечивается типами: она честно приводит функцию к
 * строке, то есть кладёт в промпт её исходный код.
 *
 * В прод уезжало буквально:
 *   () => t("characters.stage_note") () => t("characters.tone")
 *
 * а не уезжало вот это:
 *   • «Если запрос вне твоей компетенции — скажи, к кому из команды
 *     обратиться, не выдумывай результат чужой работы» — единственная защита
 *     от того, чтобы роль сочиняла результат чужой работы;
 *   • «Тон: спокойный… без воды и эмодзи. Отвечай по-русски, кратко» — тон и
 *     язык ответа.
 *
 * То есть все роли, кроме Lead, работали без правила «не выдумывай за коллег»
 * и без указания языка, зато с обрывком JS в конце промпта.
 */
import { describe, test, expect } from "bun:test";
import { CHARACTERS } from "../characters/index.ts";
import { t } from "../lib/i18n.js";

describe("системные промпты не содержат исходников функций", () => {
  for (const c of CHARACTERS) {
    test(`${c.key}: без стрелочных функций в тексте`, () => {
      expect(c.system).not.toContain("=>");
      expect(c.system).not.toContain("t(\"characters.");
      expect(c.system).not.toContain("t('characters.");
    });
  }
});

describe("каждая роль получает stage note и тон", () => {
  const stageNote = t("characters.stage_note");
  const tone = t("characters.tone");

  test("тексты вообще не пустые (иначе проверка ниже бессмысленна)", () => {
    expect(stageNote.length).toBeGreaterThan(20);
    expect(tone.length).toBeGreaterThan(20);
  });

  for (const c of CHARACTERS) {
    test(`${c.key}`, () => {
      expect(c.system).toContain(stageNote);
      expect(c.system).toContain(tone);
      // Состав команды подставляется той же ленивой функцией — проверяем и его.
      expect(c.system).toContain(t("characters.team_roster"));
    });
  }
});
