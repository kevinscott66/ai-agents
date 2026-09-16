/**
 * Что именно смотрят докблок-сторожа: один список корней на всех.
 *
 * Аудит 2026-09-11, круг 51. Три гейта — протухшие координаты, осиротевшие
 * докблоки, `@param` над не-функцией — держали по своей копии одного и того же
 * массива `ROOTS` и по своей копии `walk`. Копия правила это правило,
 * действующее на N−1 из N мест, и ровно так оно и вышло: во всех трёх копиях
 * корни перечисляли подкаталоги `agent/`, а восьми файлов САМОГО `agent/`
 * (`agent.ts`, `orchestrator-team.ts` — боевая точка входа прода, и ещё шесть)
 * не смотрел никто. Замер: 799 строк вне любого сторожа; там и жила протухшая
 * координата на `autonomous-cycle.sh` в ветке `--mode review`.
 *
 * Поэтому корни и обход переехали сюда, а к рекурсивным корням добавлен
 * НЕрекурсивный верхний уровень: подкаталоги `agent/` перечислены явно, и
 * зайти в `data/`, `backups/`, `archive/` или `characters/` обход не должен —
 * это не код под контрактом, а хранилище.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Рекурсивные корни. Верхний уровень `agent/` добавляет `gateFiles`. */
export const ROOTS = ["lib", "orchestrator", "tests", "tools", "mac-daemon", "miniapp/src"];

export type WalkOpts = {
  /**
   * Пропускать каталоги `fixtures`.
   *
   * Нужно сторожу координат: фикстура — это ОБРАЗЕЦ дефекта, и координата
   * внутри неё протухшая намеренно. Двум другим сторожам фикстуры не мешают.
   */
  skipFixtures?: boolean;
};

export function walk(dir: string, out: string[] = [], opts: WalkOpts = {}): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    if (opts.skipFixtures && e === "fixtures") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out, opts);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Файлы верхнего уровня `agent/` — без спуска в каталоги. */
export function topLevelFiles(): string[] {
  return readdirSync(".")
    .filter((e) => !e.startsWith(".") && (e.endsWith(".ts") || e.endsWith(".tsx")))
    .filter((e) => statSync(e).isFile());
}

/** Всё, что обязан смотреть докблок-сторож: корни рекурсивно плюс верхний уровень. */
export function gateFiles(opts: WalkOpts = {}): string[] {
  const out: string[] = [];
  for (const root of ROOTS) walk(root, out, opts);
  out.push(...topLevelFiles());
  return out;
}
