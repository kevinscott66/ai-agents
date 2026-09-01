/**
 * Аудит 2026-08-21: срок жизни pending-черновика был записан в четырёх местах
 * и в трёх из них — неправильно.
 *
 * Константа одна по смыслу и две по факту: `MAX_AGE_MS` (approve-poll.ts) и
 * `PENDING_MAX_AGE_MS` (daily-draft.ts), обе 20ч. Двадцать, а не двадцать
 * четыре — инцидент 2026-08-14: ровно сутки означали период таймера в период
 * таймера, и черновик протухал за миг до собственного поллинга.
 *
 * А обещали вокруг 24ч: докстринг модуля (:12), комментарий прямо над самой
 * проверкой (:570), заголовок юнита `deploy/systemd/delabs-approve-poll.service`
 * и комментарий `pendingAwaitingApproval` в daily-draft.ts. То есть выпуск,
 * одобренный на 21-м часу, молча выбрасывался, а вся документация вокруг
 * говорила, что он ещё жив.
 *
 * Тест сторожит две вещи, которые расходились: равенство двух констант и
 * отсутствие в текстах обещания другого срока. Проверка по исходнику здесь
 * уместна — расходились именно тексты, а поведение у обеих сторон одинаковое.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { MAX_AGE_MS } from "../tools/approve-poll.ts";
import { PENDING_MAX_AGE_MS } from "../tools/daily-draft.ts";

const HOURS = MAX_AGE_MS / 3_600_000;
const SOURCES = [
  "../tools/approve-poll.ts",
  "../tools/daily-draft.ts",
  "../../deploy/systemd/delabs-approve-poll.service",
];

describe("срок жизни pending-черновика", () => {
  test("обе стороны живут по одному сроку", () => {
    expect(MAX_AGE_MS).toBe(PENDING_MAX_AGE_MS);
    expect(HOURS).toBe(20);
  });

  test("тексты вокруг не обещают другого срока", () => {
    for (const rel of SOURCES) {
      const src = readFileSync(new URL(rel, import.meta.url), "utf8");
      for (const line of src.split("\n")) {
        // Историческую справку про инцидент не трогаем: там 24ч — это рассказ
        // о том, КАК БЫЛО, и он обязан остаться.
        if (line.includes("Инцидент 2026-08-14")) continue;
        const promise = line.match(/старше\s*\(?>?\s*(\d+)\s*ч/iu);
        if (!promise) continue;
        expect({ rel, line: line.trim(), hours: Number(promise[1]) }).toEqual({
          rel,
          line: line.trim(),
          hours: HOURS,
        });
      }
    }
  });
});
