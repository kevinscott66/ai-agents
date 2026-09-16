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
 *
 * Круг 30: проверялся только camelCase, а половина имён в этом репозитории
 * пишется через подчёркивание — статусы задач, типы апдейтов Telegram,
 * переменные окружения, константы модулей. Гниют они так же. Замер по дереву:
 * 1009 упоминаний, двенадцать не нашлись, и ни одно не оказалось шумом —
 * MAC_ROOTS вместо `MAC_PROJECT_ROOTS`, SVG_TAG вместо `SVG_OPEN`,
 * MAX_BUCKETS при живых `EVICT_AT_BUCKETS`/`HARD_MAX_BUCKETS`, четыре
 * надгробия в кавычках и три чужих имени из telegraf. Поэтому правило
 * расширено здесь, а не заведено вторым тестом: копия правила — это правило,
 * действующее на N−1 из N мест.
 *
 * Расширение потребовало и второго корня для ПОИСКА: `SERVER_EXCLUDES`,
 * `UNTRACKED_COUNT` и прочая деплойная лексика живёт в `deploy/*.sh`, и без
 * него тест нашёл бы их «мёртвыми». Это тот самый риск, из-за которого
 * сторож опаснее своего отсутствия: он отвечал бы уверенно и неверно.
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
 * Где ещё ищем имена через подчёркивание, но НЕ ищем комментарии.
 *
 * Про деплой и воркфлоу здесь пишут по именам их переменных (`SERVER_EXCLUDES`,
 * `UNTRACKED_COUNT`), а сами они — shell и YAML. Комментарии этих файлов в
 * поиск не идут: `#`-строка, называющая мёртвую переменную, — такая же ложь, и
 * засчитывать её за доказательство жизни нельзя.
 */
const SHELLY_ROOTS = ["../deploy", "../.github"];

/**
 * Символы, которых в этом репозитории нет и не будет, — внутренности
 * зависимостей. Значение — пакет, в котором символ обязан находиться.
 */
const EXTERNAL: Record<string, string> = {
  attachFormMedia: "telegraf",
  FORM_DATA_JSON_FIELDS: "telegraf",
  callback_query: "telegraf",
  my_chat_member: "telegraf",
  addPart: "telegraf",
  deleteWebhook: "telegraf",
  handleError: "telegraf",
  retryRequest: "@anthropic-ai/sdk",
  makeRequest: "@anthropic-ai/sdk",
  messageEntityPre: "telegram",
  api_id: "telegram",
  api_hash: "telegram",
  messageEntityCode: "telegram",
  _buildingEntities: "telegram",
  _updateLoop: "telegram",
  _parseMessageText: "telegram",
  _makeAbort: "@anthropic-ai/sdk",
  autoSelectFamily: "@types/node",
};

const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;
/** Идентификатор с горбом: одного слова со строчной буквы мало. */
const CAMEL = /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/;
/**
 * Имя через подчёркивание: `semi_auto`, `HARD_MAX_BUCKETS`. Регистр не мешаем —
 * смешанное `Some_Thing` в прозе встречается как разрезанная фраза, а не как имя.
 */
const SNAKE = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)$/;
/**
 * Поле контекста: ведущее подчёркивание. Соглашение проекта — ключ payload'а с
 * `_`-префиксом подставляет вызывающий, а не модель, поэтому такие имена
 * describe'ятся в комментариях чаще прочих и протухают так же.
 *
 * Отдельным шаблоном, а не послаблением в SNAKE: разрешить там одиночное слово
 * ради _depth — значит впустить в проверку gunzip, printenv, getcwd, exports
 * и прочую прозу, у которой подчёркивания нет вовсе. Префикс сам по себе
 * достаточно редок в русском тексте, чтобы служить признаком имени.
 */
export const UNDERSCORE_FIELD = /^_[a-z][A-Za-z0-9_]*$/;
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

/** Тот же обход, но для деплойных файлов: shell, YAML, SQL. */
function walkAny(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walkAny(p, out);
    else if (/\.(sh|ya?ml|sql|ts|tsx)$/.test(p)) out.push(p);
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
/** `#` — комментарий shell и YAML; в поиск имён такие строки не идут. */
const SHELL_COMMENT = /^\s*#/;
const UNDERSCORED = /\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g;
/** Поля контекста в коде: `_userId`, `_delegation_path`, `_retry_count`. */
export const LEADING_UNDERSCORE = /\b_[A-Za-z][A-Za-z0-9_]*\b/g;

/**
 * Литеральный аргумент проверки на ОТСУТСТВИЕ в исходнике:
 * `expect(SRC).not.toContain("deriveBannerTitle")`.
 *
 * Такая строка — доказательство, что символа нет, и harvest обязан её
 * пропустить: иначе доказательство смерти имени становится ровно тем, что
 * убеждает сторожа в его жизни. Так уцелели все найденные призраки —
 * hardSlice, extractPortOnly, gatedAction названы в tests/ только внутри
 * not.toContain, и сторож считал, что видит их «в коде».
 *
 * Вырезается ТОЛЬКО литерал и только у текстовых проверок (`toContain`,
 * `toMatch`, toContainEqual): они говорят про текст исходника. `not.toBe`
 * сравнивает значения, а не наличие символа, и остаётся нетронутым. Левая
 * часть строки (`expect(SRC)`) тоже остаётся — имена оттуда настоящие.
 * Регулярка работает по файлу целиком, а не построчно, потому что у шести
 * проверок аргумент перенесён на следующую строку.
 */
export const ABSENCE_ARG =
  /\.not\.to(?:Contain|Match|ContainEqual)\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`|\/(?:[^/\\\n]|\\.)+\/[gimsuy]*)/g;

/**
 * Заголовок `test()` / `describe()` — такая же проза для человека, как
 * комментарий, и доказательством жизни имени быть не может: «deriveBannerTitle
 * удалён» описывает как раз мёртвое имя. Вырезается один литерал-заголовок,
 * тело блока не трогаем.
 */
export const TITLE_ARG = /\b(?:test|describe|it)\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`)/g;

/**
 * Чего этот сторож по-прежнему не видит: смерть доказывают и через
 * `"checkBacklogAlerts" in alerting` со сравнением с false, и через
 * `SRC.indexOf("hardSlice(")` с −1, и через фильтр по `line.includes(...)` с
 * пустым результатом. Литерал там неотличим от живого имени без разбора
 * выражения, а парсер ради этого заводить дороже пользы: такие места ловятся
 * чтением. Правило поэтому узкое и честное, а не полное.
 */
function collectIdents(src: string, isComment: (line: string) => boolean) {
  const text = src.replace(ABSENCE_ARG, ".not.to(").replace(TITLE_ARG, "test(");
  for (const line of text.split("\n")) {
    if (isComment(line)) continue;
    for (const m of line.matchAll(/\b[a-z][A-Za-z0-9]{3,}\b/g)) codeIdents.add(m[0]);
    for (const m of line.matchAll(UNDERSCORED)) codeIdents.add(m[0]);
    // UNDERSCORED начинается с буквы, поэтому `_userId` целиком не собирает:
    // границы слова перед `_` внутри имени нет. Отдельный проход за ними.
    for (const m of line.matchAll(LEADING_UNDERSCORE)) codeIdents.add(m[0]);
  }
}
for (const src of read(IDENT_ROOTS).values()) {
  collectIdents(src, (l) => COMMENT_LINE.test(l));
}
for (const root of SHELLY_ROOTS) {
  if (!existsSync(root)) continue;
  for (const f of walkAny(root)) {
    collectIdents(readFileSync(f, "utf8"), (l) => SHELL_COMMENT.test(l));
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
          if (name.length < MIN_LEN) continue;
          if (!CAMEL.test(name) && !SNAKE.test(name) && !UNDERSCORE_FIELD.test(name))
            continue;
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
