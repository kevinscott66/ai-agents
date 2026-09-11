/**
 * Аудит 2026-09-11, круг 22: имя в обратных кавычках тухнет так же тихо, как
 * координата строки, — и подрывает лечение круга 20.
 *
 * Круг 20 запретил ссылки вида `модуль.ts:471` и велел вместо номера называть
 * символ: «такая ссылка не тухнет вовсе». Это оказалось правдой наполовину.
 * Символ переживает вставку выше по файлу, но не переживает переименование:
 * runToolLoop стал `runWithTools`, checkPermission — `evaluateGate`,
 * toTelegramHtml — `mdToTelegramHtml`, а комментарии остались. Из четырнадцати
 * найденных этой проверкой два были свежими — их вписал сам круг 20, выполняя
 * собственную рекомендацию (listTasks вместо `listTasksByAssignee`).
 *
 * Цена ровно та же, что у протухшей координаты, и хуже: читатель идёт искать
 * названный символ, не находит НИЧЕГО и остаётся без способа проверить
 * утверждение комментария. Grep по мёртвому имени молчит, а вывод «комментарий
 * врёт, код переименовали» делает не каждый — чаще решают, что смотрят не туда.
 *
 * (Мёртвые имена в этом абзаце намеренно без обратных кавычек — по правилу,
 * которое тест и вводит. Иначе он падал бы на собственной докстроке; он и
 * упал, когда я написал её по-старому.)
 *
 * Инвариант: обратные кавычки вокруг camelCase-идентификатора — это обещание,
 * что символ найдётся. Найдётся либо в коде репозитория, либо в пакете, из
 * которого он взят (о внутренностях telegraf и SDK мы пишем много и по делу).
 *
 * Что делать, когда тест упал:
 *  • символ переименовали → назвать новое имя;
 *  • символ УДАЛИЛИ, а речь именно об истории («раньше поле звалось isPaused»)
 *    → снять обратные кавычки. Кавычки обещают существование; про мёртвое имя
 *    пишут без них. Так сделано в lib/role-skills.ts, lib/i18n.ts и
 *    tests/delegate-disabled-agent-availability.test.ts;
 *  • символ чужой → внести в EXTERNAL вместе с пакетом. Пакет проверяется
 *    ниже, поэтому выдумать его, чтобы замолчать тест, не выйдет.
 */
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/** Комментарии, которые проверяем, — дерево агента целиком. */
const SCAN_ROOTS = [
  "lib",
  "orchestrator",
  "tests",
  "tools",
  "mac-daemon",
  "characters",
  "miniapp/src",
];

/**
 * Где ищем сам символ. Шире, чем SCAN_ROOTS, на дерево сайта: агент ссылается
 * на него по делу и часто — `safeStoredUrl`, `reusableDigestId`,
 * `findLatestDigestByTitle` живут там, а пишут о них здесь, потому что ingest
 * идёт отсюда туда. Если сайт переименует такой символ, комментарий агента
 * протухнет — и должен упасть именно тут.
 */
const IDENT_ROOTS = [...SCAN_ROOTS, "../site/server"];

/**
 * Символы, которых в этом репозитории нет и не будет, — внутренности
 * зависимостей. Значение — пакет, в котором символ обязан находиться.
 */
const EXTERNAL: Record<string, string> = {
  attachFormMedia: "telegraf",
  addPart: "telegraf",
  deleteWebhook: "telegraf",
  handleError: "telegraf",
  retryRequest: "@anthropic-ai/sdk",
  makeRequest: "@anthropic-ai/sdk",
  messageEntityPre: "telegram",
  messageEntityCode: "telegram",
  autoSelectFamily: "@types/node",
};

const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
/** Идентификатор с горбом: одного слова со строчной буквы мало. */
const CAMEL = /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/;
/**
 * Короткие имена не проверяем: `isOk`, `toB` и им подобные слишком часто
 * встречаются в прозе как куски чужих выражений, а пользы от них ноль.
 */
const MIN_LEN = 5;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e.startsWith(".")) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

const read = (roots: string[]) =>
  new Map(
    roots
      .flatMap((r) => (existsSync(r) ? walk(r) : []))
      .map((f) => [f, readFileSync(f, "utf8")] as const),
  );

/** Файлы, чьи комментарии проверяются. */
const sources = read(SCAN_ROOTS);

/**
 * Все идентификаторы, встреченные в НЕ-комментарных строках.
 *
 * Грубо и намеренно: объявление, вызов, поле объекта и строковый литерал здесь
 * неразличимы. Тест отвечает на вопрос «такое слово в коде вообще есть», а не
 * «символ экспортирован оттуда, откуда думает автор» — второе машина не решит,
 * а первого хватило, чтобы найти все четырнадцать.
 */
const codeIdents = new Set<string>();
for (const src of read(IDENT_ROOTS).values()) {
  for (const line of src.split("\n")) {
    if (COMMENT_LINE.test(line)) continue;
    for (const m of line.matchAll(/\b[a-z][A-Za-z0-9]{3,}\b/g)) codeIdents.add(m[0]);
  }
}

describe("имена символов в комментариях не протухли", () => {
  test("каждое имя в обратных кавычках существует", () => {
    const rotted: string[] = [];
    for (const [file, src] of sources) {
      src.split("\n").forEach((line, i) => {
        if (!COMMENT_LINE.test(line)) return;
        for (const m of line.matchAll(/`([^`]+)`/g)) {
          const name = m[1].replace(/\(\)$/, "");
          if (name.length < MIN_LEN || !CAMEL.test(name)) continue;
          if (codeIdents.has(name) || name in EXTERNAL) continue;
          rotted.push(`${file}:${i + 1} \`${name}\``);
        }
      });
    }
    expect(rotted).toEqual([]);
  });

  test("каждая запись EXTERNAL подтверждается своим пакетом", () => {
    const bad: string[] = [];
    for (const [name, pkg] of Object.entries(EXTERNAL)) {
      const dir = join("node_modules", pkg);
      // Дерева зависимостей может не быть (свежий клон без bun install) —
      // тогда проверять нечего, и падать не на чем.
      if (!existsSync(dir)) continue;
      const r = spawnSync("grep", ["-rwq", name, dir], { stdio: "ignore" });
      if (r.status !== 0) bad.push(`${name} — в ${pkg} не найден`);
    }
    expect(bad).toEqual([]);
  });
});
