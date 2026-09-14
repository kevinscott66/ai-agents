/**
 * Аудит 2026-09-11, круг 28: у сайта не было НИ ОДНОЙ проверки комментариев,
 * и он накопил ровно те дефекты, от которых агентское дерево прикрыто.
 *
 * В agent/tests с круга 20 живут четыре сторожа: координата указывает хоть на
 * что-то; имя символа и номер строки не ходят парой; докблоки не стоят по два
 * подряд; `@param`/`@returns` не висят над константой. Сайт — тот же репозиторий
 * и тот же жанр комментария («докстрока утверждала X, а код делает Y»), но
 * сторожей там не было вовсе, потому что ROOTS тех тестов перечисляют каталоги
 * агента, а site/server лежит отдельным пакетом со своим прогоном.
 *
 * Цена измерена, а не предположена. Первый же прогон этого файла нашёл восемь
 * дефектов, накопленных с 2026-08-20: пять протухших координат `index.ts:NNN`
 * в докстроках тестов (`SHARED_LOCAL_KEYS` звали по номеру 141 при настоящем
 * 246, `toStringArray` — по 1285 при 1651) и три чужих докблока: разбор
 * `tokenMatches` над `ingestSecret`, разбор `lastUnlocksRefreshIso` над
 * `const MAX_DATE_MS`, разбор `digestSearchText` над `digestItemText`.
 *
 * Проверки намеренно скопированы по СМЫСЛУ, а не импортом: у пакетов разные
 * прогоны и разные корни, а связывать их файлом ради экономии двадцати строк
 * значило бы завести зависимость между двумя гейтами, которые сейчас можно
 * запускать порознь. Расходятся они только в ROOTS.
 */
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, normalize, basename } from "node:path";

/** Пакет плоский: исходники и тесты лежат рядом в этом же каталоге. */
const ROOT = ".";
const SKIP_DIRS = new Set(["node_modules", "dist", "data"]);

/** Дефект — врущий КОММЕНТАРИЙ; такая же строка в коде это фикстура. */
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const FILES = walk(ROOT);

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

// ── 1. Координата указывает хоть на что-то ──────────────────────────────────

const COORD = /([A-Za-z0-9_./-]+\.tsx?):(\d+)(?:-(\d+))?/g;
const EMPTY_TARGET = new Set(["", "}", "};", "});", "),", ")", ");", "],", "]", "*/", "{", "//"]);

/** Корень репозитория относительно этого пакета: site/server → сюда два шага. */
const REPO_ROOT = "../..";

/**
 * Круг 30: ссылки вида `agent/lib/…` не разрешались ВООБЩЕ.
 *
 * Комментарии сайта регулярно ссылаются в дерево агента — там живут вторые
 * половины общих контрактов (`clientIpKey`, `ingestArticle`). Такие ссылки
 * начинаются с `agent/`, то есть отсчитываются от корня репозитория, а не от
 * этого пакета; ни один из трёх прежних кандидатов до них не доставал, и
 * `resolveTarget` молча возвращал null — ровно то же, что «цель не из этого
 * дерева». Сторож их пропускал, и они гнили дольше всех остальных.
 *
 * Замер: три такие ссылки в дереве, две указывали на голую `}`.
 *
 * Кандидат добавлен последним: сначала пакет, потом корень. Если однажды в
 * site/server появится свой каталог `agent`, выиграет местный — читатель
 * ссылки из site/server имеет в виду прежде всего своё дерево.
 */
function resolveTarget(from: string, ref: string): string | null {
  for (const c of [
    normalize(join(dirname(from), ref)),
    normalize(ref),
    normalize(join(REPO_ROOT, ref)),
  ]) {
    if (fileLines(c)) return c;
  }
  const c = join(ROOT, basename(ref));
  return fileLines(c) ? c : null;
}

describe("координаты строк в комментариях не протухли", () => {
  test("каждая ссылка `модуль.ts:N` указывает на строку с содержимым", () => {
    const stale: string[] = [];
    for (const file of FILES) {
      fileLines(file)!.forEach((line, i) => {
        if (!COMMENT_LINE.test(line)) return;
        for (const m of line.matchAll(COORD)) {
          const target = resolveTarget(file, m[1]);
          if (!target) continue; // цель не из этого дерева
          const body = fileLines(target)!;
          const n = Number(m[2]);
          if (n < 1 || n > body.length) {
            stale.push(`${file}:${i + 1} → ${m[0]} (в файле ${body.length} строк)`);
            continue;
          }
          const at = body[n - 1]!.trim();
          if (EMPTY_TARGET.has(at)) {
            stale.push(`${file}:${i + 1} → ${m[0]} указывает на ${JSON.stringify(at)}`);
          }
        }
      });
    }
    expect(stale).toEqual([]);
  });
});

// ── 2. Имя символа и номер строки не ходят парой ────────────────────────────

/**
 * В этой связке номер не добавляет ничего — имя уже названо и grep'ом ищется
 * дешевле, — а ломается от любой вставки выше по файлу. Поэтому здесь не
 * «сверь номер», а «номера тут быть не должно».
 */
const SYMBOL_THEN_COORD = /`[A-Za-z_][A-Za-z0-9_]*`\s*\(`?[A-Za-z0-9_./-]+\.tsx?:\d+`?\)/;

describe("имя символа и номер строки не ходят парой", () => {
  test("после имени в кавычках не стоит координата", () => {
    const found: string[] = [];
    for (const file of FILES) {
      fileLines(file)!.forEach((line, i) => {
        if (!COMMENT_LINE.test(line)) return;
        const m = line.match(SYMBOL_THEN_COORD);
        if (m) found.push(`${file}:${i + 1} → ${m[0]}`);
      });
    }
    expect(found).toEqual([]);
  });
});

// ── 3 и 4. Докблок стоит над тем, что описывает ─────────────────────────────

const DOC_OPENS = /^\s*\/\*\*/;
const DOC_ENDS = /\*\//;

/**
 * Похоже ли на объявление вызываемого. Намеренно широко: цена ложного
 * срабатывания выше цены пропуска, дефект — «над КОНСТАНТОЙ».
 */
const CALLABLE =
  /(\bfunction\b|=>|\)\s*(:[^=]*)?\{\s*$|\bconstructor\b|^\s*(export\s+)?(async\s+)?[A-Za-z_$][\w$]*\s*(<[^>]*>)?\s*\()/;

/**
 * Тег только в начале строки блока: внутри кавычек `"@param"` — это данные.
 * Единственные два тега, которые ОБЯЗЫВАЮТ владельца быть вызываемым.
 */
const OWNER_TAG = /^\s*\*\s*@(param|returns?)\b/m;

type Doc = { start: number; end: number; body: string };

function docBlocks(lines: string[]): Doc[] {
  const out: Doc[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!DOC_OPENS.test(lines[i]!)) continue;
    let end = i;
    while (end < lines.length && !DOC_ENDS.test(lines[end]!)) end++;
    if (end >= lines.length) break;
    out.push({ start: i, end, body: lines.slice(i, end + 1).join("\n") });
    i = end;
  }
  return out;
}

describe("докблок описывает символ прямо под собой", () => {
  test("два докблока подряд — второй перехватил владельца первого", () => {
    const found: string[] = [];
    for (const file of FILES) {
      const lines = fileLines(file)!;
      const docs = docBlocks(lines);
      for (let k = 0; k + 1 < docs.length; k++) {
        const gap = lines.slice(docs[k]!.end + 1, docs[k + 1]!.start);
        if (gap.every((l) => l.trim() === "") && gap.length <= 1) {
          found.push(`${file}:${docs[k]!.start + 1} — докблок без своего символа`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  test("`@param`/`@returns` не висят над тем, у чего нет параметров", () => {
    const found: string[] = [];
    for (const file of FILES) {
      const lines = fileLines(file)!;
      for (const d of docBlocks(lines)) {
        if (!OWNER_TAG.test(d.body)) continue;
        let j = d.end + 1;
        while (j < lines.length && (lines[j]!.trim() === "" || /^\s*\/\//.test(lines[j]!))) j++;
        const owner = lines[j] ?? "";
        if (!CALLABLE.test(owner)) {
          found.push(`${file}:${d.end + 2} — над «${owner.trim().slice(0, 60)}»`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

describe("сами сторожа различают то, ради чего заведены", () => {
  test("вызываемым считается и функция, и метод, и стрелка", () => {
    for (const o of [
      "export function tokenMatches(provided: string | null): boolean {",
      "  async handle(req: Request): Promise<Response> {",
      "const f = (a: number) => a + 1;",
    ]) {
      expect(CALLABLE.test(o)).toBe(true);
    }
  });

  test("константа вызываемой не считается — иначе проверка пуста", () => {
    for (const o of ["const MAX_DATE_MS = 8.64e15;", "export const META_DESC_MAX = 300;"]) {
      expect(CALLABLE.test(o)).toBe(false);
    }
  });

  test("в дереве сайта есть что проверять", () => {
    // Сторож, которому нечего обходить, зелен всегда и не значит ничего.
    expect(FILES.length).toBeGreaterThan(50);
  });
});
