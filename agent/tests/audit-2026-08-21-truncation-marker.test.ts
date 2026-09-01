/**
 * Аудит 2026-08-21: многоточие, которое врало.
 *
 * Mini App резал длинный текст в четырёх местах — четырьмя разными способами,
 * и три из них показывали пользователю не то, что есть:
 *
 *   • `Agents.tsx` — `{action.error.slice(0, 100)}...`, без всякого условия.
 *     Ошибки агентов почти все короче ста символов («timeout», «HTTP 429»), и
 *     каждая рисовалась как «timeout...», то есть как обрезанная. Дальше уже
 *     ни одной строке верить нельзя: по экрану не отличить настоящий обрыв от
 *     приписанного.
 *   • `Logs.tsx` — `` ` · ${a.error.slice(0, 80)}` ``, метки нет вовсе. Ошибка
 *     на 300 символов выглядела законченной фразой. Это хуже лишнего
 *     многоточия: там видно, что чего-то не хватает, здесь — нет, и вкладка
 *     «Логи» ровно для того и открыта, чтобы прочитать ошибку целиком.
 *   • `Mac.tsx` (два места) — условие верное, но метка из трёх точек ASCII.
 *
 * Правильной была одна `InterAgentCard.tsx`. Правило стало общим —
 * `lib/text.ts`, — и проверяется здесь, потому что склеить маркер со `slice`
 * руками проще всего именно в JSX: там это одна строка.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ellipsize, ELLIPSIS } from "../miniapp/src/lib/text.ts";

const SRC = join(import.meta.dir, "..", "miniapp", "src");

function sources(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (name.endsWith(".tsx") || name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const FILES = sources();
const rel = (p: string) => p.slice(SRC.length + 1);

/**
 * Убрать комментарии, сохранив разбивку на строки.
 *
 * Иначе тест ловит сам себя: докстринг `lib/text.ts` цитирует ровно ту идиому,
 * которую запрещает, и сканер честно сообщает о нарушении в тексте объяснения.
 * `://` не трогаем, чтобы не съесть половину строки с URL.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, pre) => pre);
}

describe("ellipsize", () => {
  test("короткий текст не трогаем и метку не приписываем", () => {
    expect(ellipsize("timeout", 100)).toBe("timeout");
    expect(ellipsize("timeout", 100)).not.toContain(ELLIPSIS);
  });

  test("ровно по лимиту — тоже без метки", () => {
    expect(ellipsize("12345", 5)).toBe("12345");
  });

  test("длиннее лимита — режем и помечаем", () => {
    expect(ellipsize("123456", 5)).toBe(`1234${ELLIPSIS}`);
  });

  test("метка входит в бюджет: результат не длиннее лимита", () => {
    for (const max of [1, 2, 5, 10, 80, 100, 150]) {
      expect(ellipsize("x".repeat(500), max).length).toBeLessThanOrEqual(max);
    }
  });

  test("пробел перед меткой убираем — «слово …» читается как конец фразы", () => {
    expect(ellipsize("hello world", 7)).toBe(`hello${ELLIPSIS}`);
  });

  test("метка — один код-поинт, а не три точки", () => {
    expect(ELLIPSIS).toBe("…");
    expect(ELLIPSIS.length).toBe(1);
    expect(ellipsize("x".repeat(20), 5)).not.toContain("...");
  });

  test("вырожденные лимиты не роняют и не отдают мусор", () => {
    expect(ellipsize("abc", 0)).toBe("");
    expect(ellipsize("abc", -5)).toBe("");
    expect(ellipsize("", 10)).toBe("");
  });

  test("пустой ввод не превращается в одинокое многоточие", () => {
    expect(ellipsize("", 1)).toBe("");
  });
});

describe("инвариант: маркер не приклеивается к slice руками", () => {
  /** Идиомы, которыми маркер лепили до правки. */
  const GLUED = [
    // {x.slice(0, N)}...  — Agents
    /\.slice\(\s*0\s*,[^)]*\)\s*\}\s*(?:\.\.\.|…)/,
    // x.slice(0, N) + "…" / + '...'
    /\.slice\(\s*0\s*,[^)]*\)\s*\+\s*["'`]\s*(?:\.\.\.|…)/,
    // {x.length > N ? "..." : ""} — Mac
    /\.length\s*>\s*\d+\s*\?\s*["'`](?:\.\.\.|…)["'`]/,
  ];

  test("ни в одном файле src/", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      const src = stripComments(readFileSync(f, "utf8"));
      for (const line of src.split("\n")) {
        if (GLUED.some((re) => re.test(line))) bad.push(`${rel(f)}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("контроль: сами регулярки ловят все три прежние идиомы", () => {
    const samples = [
      '{action.error.slice(0, 100)}...',
      'body.slice(0, PREVIEW_CHARS) + "…"',
      '{session.prompt.length > 100 ? "..." : ""}',
    ];
    for (const s of samples) {
      expect(GLUED.some((re) => re.test(s))).toBe(true);
    }
  });

  test("контроль: обычный slice по массиву под запрет не попадает", () => {
    const ok = "setRecent(d.recentActions.slice(0, 10));";
    expect(GLUED.some((re) => re.test(ok))).toBe(false);
  });
});

describe("инвариант: три точки не дописываются после выражения", () => {
  /** `{expr}...` в JSX и `${expr}...` в шаблоне — та самая склейка из Agents. */
  const TRAILING = /\}\s*\.\.\./;

  test("ни в одном файле src/", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      const src = stripComments(readFileSync(f, "utf8"));
      for (const line of src.split("\n")) {
        if (TRAILING.test(line)) bad.push(`${rel(f)}: ${line.trim()}`);
      }
    }
    expect(bad).toEqual([]);
  });

  test("контроль: прежняя строка Agents ловится", () => {
    expect(TRAILING.test("{action.error.slice(0, 100)}...")).toBe(true);
  });

  test("контроль: JSON-плейсхолдер с многоточием — не нарушение", () => {
    // Tasks.tsx подсказывает формат: placeholder='{"goal": "..."}'. Многоточие
    // тут — часть примера, а не метка обрезки.
    expect(TRAILING.test(`placeholder='{"goal": "..."}'`)).toBe(false);
  });
});

describe("все четыре места ходят через общий хелпер", () => {
  const at = (p: string) => readFileSync(join(SRC, p), "utf8");

  test("Agents: ошибка действия", () => {
    expect(at("pages/Agents.tsx")).toContain("ellipsize(action.error, 100)");
  });

  test("Logs: ошибка в строке метаданных", () => {
    expect(at("pages/Logs.tsx")).toContain("ellipsize(a.error, 80)");
  });

  test("Mac: превью промпта в обоих списках", () => {
    const src = at("pages/Mac.tsx");
    expect(src).toContain("ellipsize(session.prompt, 100)");
    expect(src).toContain("ellipsize(session.prompt, 150)");
  });

  test("InterAgentCard: превью тела", () => {
    const src = at("components/InterAgentCard.tsx");
    expect(src).toContain("ellipsize(body, PREVIEW_CHARS)");
    // Кнопка «развернуть» показывается по тому же условию, что и обрезка.
    expect(src).toContain("const isLong = body.length > PREVIEW_CHARS;");
  });
});
