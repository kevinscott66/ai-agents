/**
 * Аудит 2026-09-11, круг 20: координаты вида `модуль.ts:471` в комментариях
 * протухают молча.
 *
 * В этом репозитории комментарий — источник правды наравне с кодом: почти
 * каждая правка аудита начинается словами «докстрока утверждала X, а код
 * делает Y». Ссылка на номер строки ломается иначе, чем текст: её ломает не
 * правка того места, на которое она указывает, а ЛЮБАЯ вставка выше по файлу.
 * Автор ссылки при этом ничего не редактирует и ни о чём не узнаёт.
 *
 * Цена — не «неточность». Читатель (человек или роль) идёт по координате и
 * читает ТАМ ДРУГОЙ КОД, приняв его за названный. Два свежих примера, оба
 * найдены этим тестом: `lib/dispatch/media.ts` посылал за списком ролей
 * GENERATE_IMAGE по координате, где давно лежит абзац про
 * `mac_bridge_connected`; `lib/dispatch/build-payload.ts` посылал за
 * `ORDER BY priority DESC` туда, где стоит `vals.push(task.id)`. Ни одна
 * из двух координат не указывала на названное — оба комментария теперь
 * называют символ (`ROLE_EXPOSED_TOOLS`, `listTasksByAssignee`) и не тухнут.
 *
 * Проверить «координата указывает на то, что имел в виду автор» машина не
 * может. Проверить «координата указывает хоть на что-то» — может, и этого
 * достаточно: сдвиг файла вставкой почти всегда выносит ссылку на пустую
 * строку, закрывающую скобку или хвост комментария. Так найдены все 46
 * протухших ссылок круга 20.
 *
 * Что делать, когда тест упал: НЕ подгонять номер. Убрать номер и назвать
 * символ — `permissions.ts`, запись `GENERATE_IMAGE` — такая ссылка не тухнет
 * вовсе. Номер оставляют только там, где называть нечего.
 */
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, normalize, basename } from "node:path";

const ROOTS = ["lib", "orchestrator", "tests"];
/** Куда ссылаются: там ищем цель, если путь ссылки не разрешился как есть. */
const LOOKUP_DIRS = ["lib", "lib/dispatch", "orchestrator", "tests", "tools", "mac-daemon"];

/** Ссылка на строку файла: `путь/модуль.ts:471` либо `модуль.ts:471-480`. */
const COORD = /([A-Za-z0-9_./-]+\.ts):(\d+)(?:-(\d+))?/g;

/**
 * Смотрим только комментарии.
 *
 * Дефект — врущий комментарий, а не врущая строка кода: в коде такая же
 * координата это обычно фикстура — строка стека, которую подают на вход
 * `isTelegrafNoise`. Она ни на что не ссылается и протухнуть не может.
 */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

/**
 * Строка «ни на что»: пустая либо только из закрывающей пунктуации.
 *
 * Список закрытый и намеренно узкий: тест обязан ловить протухшее, а не
 * спорить о стиле. Всё, где есть хоть какой-то идентификатор, считается
 * содержимым — даже если автор имел в виду соседнюю строку.
 */
const EMPTY_TARGET = new Set(["", "}", "};", "});", "),", ")", ");", "],", "]", "*/", "{", "//"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const cache = new Map<string, string[] | null>();
function fileLines(p: string): string[] | null {
  if (!cache.has(p)) {
    try {
      cache.set(p, readFileSync(p, "utf8").split("\n"));
    } catch {
      cache.set(p, null);
    }
  }
  return cache.get(p) ?? null;
}

/** Путь ссылки → реальный файл, либо null (цель вне проверки: фикстуры, чужие деревья). */
function resolveTarget(from: string, ref: string): string | null {
  for (const c of [normalize(join(dirname(from), ref)), normalize(ref)]) {
    if (fileLines(c)) return c;
  }
  const base = basename(ref);
  for (const d of LOOKUP_DIRS) {
    const c = join(d, base);
    if (fileLines(c)) return c;
  }
  return null;
}

describe("координаты строк в комментариях не протухли", () => {
  test("каждая ссылка `модуль.ts:N` указывает на строку с содержимым", () => {
    const stale: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const lines = fileLines(file);
        if (!lines) continue;
        lines.forEach((line, i) => {
          if (!COMMENT_LINE.test(line)) return;
          for (const m of line.matchAll(COORD)) {
            const target = resolveTarget(file, m[1]);
            if (!target) continue; // цель не из этого дерева — не наша ссылка
            const body = fileLines(target)!;
            const n = Number(m[2]);
            if (n < 1 || n > body.length) {
              stale.push(`${file}:${i + 1} → ${m[0]} (в файле ${body.length} строк)`);
              continue;
            }
            const at = body[n - 1].trim();
            if (EMPTY_TARGET.has(at)) {
              stale.push(`${file}:${i + 1} → ${m[0]} указывает на ${JSON.stringify(at)}`);
            }
          }
        });
      }
    }
    expect(stale).toEqual([]);
  });
});
