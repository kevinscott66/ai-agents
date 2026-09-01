/**
 * T-811: `agent/lib/telegram-format.ts` содержал сырые NUL-байты — они там
 * служат разделителями плейсхолдеров. Из-за них git и grep считали файл
 * бинарным: `git diff` показывал «Binary files differ», а `grep` без `-a`
 * молча находил ноль совпадений. Каждый, кто искал по этому файлу, терял
 * итерацию, пока не догадывался про флаг.
 *
 * Лечение — писать разделитель escape-последовательностью `\u0000`: строка на
 * выходе та же, исходник остаётся текстом. Тест сторожит, чтобы сырой байт не
 * вернулся ни сюда, ни в соседние модули.
 */
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mdToTelegramHtml } from "../lib/telegram-format.ts";

const ROOT = new URL("..", import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("T-811: в исходниках нет сырых NUL-байтов", () => {
  test("lib/, tools/ и tests/ читаются как текст", () => {
    const offenders = [join(ROOT, "lib"), join(ROOT, "tools"), join(ROOT, "tests")]
      .flatMap((d) => walk(d))
      .filter((f) => readFileSync(f).includes(0x00))
      .map((f) => f.slice(ROOT.length));
    expect(offenders).toEqual([]);
  });

  test("разделитель остался тем же символом — поведение не изменилось", () => {
    // Инлайновый код защищается плейсхолдером и восстанавливается обратно;
    // если бы разделитель поменялся, восстановление сломалось бы.
    expect(mdToTelegramHtml("текст `код` хвост")).toBe(
      "текст <code>код</code> хвост",
    );
    expect(mdToTelegramHtml("```\nblock\n```")).toContain("<pre>");
  });

  test("плейсхолдер не протекает в вывод", () => {
    const out = mdToTelegramHtml("**жирный** и `код` и *курсив*");
    expect(out).not.toContain("\u0000");
  });
});
