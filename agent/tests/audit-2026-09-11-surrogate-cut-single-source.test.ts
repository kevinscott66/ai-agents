/**
 * Аудит 2026-09-11, круг 26: правило «не разрубать суррогатную пару» жило
 * копиями, и два места обрезки его не унаследовали.
 *
 * Круг 25 чинил третье место (`replyForTurnError`) и сам же записал в
 * комментарии, что правило не новое: его держат `cutBlock`
 * (lib/telegram-format.ts) и `sliceOneEnd` (lib/telegram-chunking.ts). Чинил
 * он копированием двух строк — и этим объяснил, почему оставшиеся два места
 * правила не знали: импортировать было нечего.
 *
 * Оставшиеся два:
 *   - подтверждение расшифровки голоса, `slice(0, 100)` — уходит ЧЕЛОВЕКУ в
 *     чат (orchestrator/voice-handler.ts);
 *   - срез текстового вложения по `MAX_DOC_CHARS` — уходит В ПРОМПТ модели и
 *     в короткую память (orchestrator/message-handler.ts).
 * Эмодзи на границе среза оставлял в хвосте одинокий высокий суррогат: в
 * Telegram человек видит ромб, в SQLite хвост склеивается со следующей
 * записью, а модель читает битый символ.
 *
 * Довод дословно тот, которым `cutBlock` объясняет свой собственный переезд
 * из `action-dispatch.ts`: «Копия правила — это правило, действующее на N−1
 * из N мест». Поэтому здесь не только поведение, но и единственность: срез
 * знает про суррогаты ровно один модуль, lib/text-cut.ts.
 *
 * `sliceOneEnd` — законное исключение и внесён списком: он двигает ИНДЕКС
 * внутри поиска границы, а не режет строку, и через общий хелпер не
 * выражается.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { cutToCodeUnits, dropLoneHighSurrogate } from "../lib/text-cut.ts";
import { replyForTurnError } from "../orchestrator/message-handler.ts";
import { BudgetExceededError } from "../lib/token-budget.ts";

/** Астральный символ: две единицы UTF-16. */
const EMOJI = "🙂";

describe("cutToCodeUnits", () => {
  test("граница внутри пары — символ не попадает в результат целиком", () => {
    const s = `${"a".repeat(9)}${EMOJI}хвост`;
    // Срез ровно между суррогатами: 10-я единица — высокий суррогат.
    const cut = cutToCodeUnits(s, 10);
    expect(cut).toBe("a".repeat(9));
    expect(cut.length).toBeLessThanOrEqual(10);
  });

  test("пара, влезшая целиком, остаётся целой", () => {
    expect(cutToCodeUnits(`${"a".repeat(9)}${EMOJI}хвост`, 11)).toBe(
      `${"a".repeat(9)}${EMOJI}`,
    );
  });

  test("результат никогда не длиннее запрошенного", () => {
    const s = `${EMOJI.repeat(20)}`;
    for (let max = 0; max <= s.length; max++) {
      expect(cutToCodeUnits(s, max).length).toBeLessThanOrEqual(max);
    }
  });

  test("короткая строка возвращается как есть, включая пустую", () => {
    expect(cutToCodeUnits("", 5)).toBe("");
    expect(cutToCodeUnits(EMOJI, 99)).toBe(EMOJI);
  });

  test("одинокого высокого суррогата в хвосте не остаётся ни при каком срезе", () => {
    const s = `текст ${EMOJI} ещё ${EMOJI}${EMOJI} конец`;
    for (let max = 0; max <= s.length; max++) {
      const cut = cutToCodeUnits(s, max);
      const last = cut.charCodeAt(cut.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  test("dropLoneHighSurrogate не трогает целую пару и пустую строку", () => {
    expect(dropLoneHighSurrogate("")).toBe("");
    expect(dropLoneHighSurrogate(`а${EMOJI}`)).toBe(`а${EMOJI}`);
    expect(dropLoneHighSurrogate(`а${EMOJI}`.slice(0, -1))).toBe("а");
  });
});

describe("правило живёт в одном месте", () => {
  const ROOTS = ["lib", "orchestrator", "tools", "mac-daemon"];
  /** Двигает индекс, а не режет строку — общим хелпером не выражается. */
  const ALLOWED = new Set(["lib/text-cut.ts", "lib/telegram-chunking.ts"]);

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
    }
    return out;
  }

  /** Дефект — КОД со своей копией правила; в комментарии это ссылка на него. */
  const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

  test("диапазон суррогатов вписан только там, где ему разрешено", () => {
    const found: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        if (ALLOWED.has(file)) continue;
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (COMMENT_LINE.test(line)) return;
            if (/0x[dD]800/.test(line)) found.push(`${file}:${i + 1}`);
          });
      }
    }
    expect(found).toEqual([]);
  });
});

describe("оба прежде не унаследовавших места режут по правилу", () => {
  test("подтверждение расшифровки не шлёт половину символа", () => {
    const SRC = readFileSync(
      join(import.meta.dir, "..", "orchestrator", "voice-handler.ts"),
      "utf8",
    );
    expect(SRC).toContain("cutToCodeUnits(transcribedText, 100)");
    expect(SRC).not.toContain("transcribedText.slice(0, 100)");
  });

  test("срез вложения в контекст модели — тоже", () => {
    const SRC = readFileSync(
      join(import.meta.dir, "..", "orchestrator", "message-handler.ts"),
      "utf8",
    );
    expect(SRC).toContain("cutToCodeUnits(content, MAX_DOC_CHARS)");
    expect(SRC).not.toMatch(/content\.slice\(0, MAX_DOC_CHARS\)/);
  });

  test("обрезка частичного ответа по-прежнему не оставляет суррогат", () => {
    const err = new BudgetExceededError("pm", 10, 5, {
      sideEffects: false,
      partialText: `${"я".repeat(698)}${EMOJI} хвост`,
    });
    const out = replyForTurnError(err);
    const head = out.split("\n\n")[0].replace(/…$/, "");
    const last = head.charCodeAt(head.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});
