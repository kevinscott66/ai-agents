/**
 * Аудит 2026-08-11: словарь i18n на 20 ключей, из которых читаются три.
 *
 * T-305 задумывался как «убрать хардкод RU/EN строк». Словарь завели, а
 * call-sites не перевели: `t()` зовут ровно в одном файле (characters/index.ts,
 * три ключа). Остальные 17 — копии строк, которые в реальных местах остались
 * литералами:
 *   'userbot.sms_code'   → tools/userbot-login.ts:100 (свой литерал)
 *   'userbot.empty_session' → tools/userbot-login.ts:118
 *   'userbot.api_id_number' → tools/userbot-login.ts:83
 *   'ui.expand'          → miniapp/src/components/InterAgentCard.tsx:99
 *   'error.general'      → miniapp/src/components/ErrorBoundary.tsx:53
 *
 * Это не падение, а ловушка: правка такого ключа выглядит как правка текста и
 * не меняет ничего. Словарь должен описывать то, что действительно читается.
 *
 * Инвариант: у каждого ключа есть потребитель.
 *
 * Аудит 2026-08-28: инвариант был заявлен, но не проверялся.
 *   1. Сверка была `consumerSource.toContain("'ключ'")` — любая строка с таким
 *      текстом считалась чтением. Комментарий «ключ 'characters.tone' пока не
 *      используем» удерживал ключ живым, и словарь снова начинал описывать не
 *      то, что читается. Ровно та ловушка, ради которой тест и писался.
 *   2. Список потребителей был захардкожен и ничем не подпирался. Файл,
 *      начавший звать `t()`, в сверку не попадал — тест продолжал считать ключ
 *      мёртвым по одному характерам, то есть врал в другую сторону.
 * Теперь сверяется вызов `t('ключ'`, а список потребителей проверяется обходом
 * дерева: кто импортирует lib/i18n, тот и обязан быть в списке.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { messages } from "../lib/i18n.ts";

const AGENT_DIR = join(import.meta.dir, "..");

/**
 * Продовые потребители `t()`. Список не декоративный: по нему считается, жив
 * ключ или мёртв. Полноту держит тест «список потребителей не устарел» ниже.
 */
const CONSUMERS = ["characters/index.ts"];

/** Каталоги, которые к прод-коду не относятся или в обход не помещаются. */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "data",
  "backups",
  "coverage",
  ".git",
  // Тесты читают `t()` ради самих проверок. Ключ, который читает только тест,
  // в проде мёртв — иначе тест сам себя объявлял бы потребителем.
  "tests",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Импорт модуля i18n — с любым числом `../` и с любым расширением. */
const IMPORTS_I18N = /(?:from|import\s*\()\s*["'][^"']*\bi18n\.(?:ts|js)["']/;

function importersOfI18n(): string[] {
  return walk(AGENT_DIR)
    .filter((p) => IMPORTS_I18N.test(readFileSync(p, "utf8")))
    .map((p) => relative(AGENT_DIR, p))
    .sort();
}

/** Настоящий вызов, а не упоминание строки: `t('ключ'` / `i18n.t("ключ"`. */
function readsKey(src: string, key: string): boolean {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("\\bt\\(\\s*(['\"`])" + esc + "\\1").test(src);
}

const consumerSource = CONSUMERS.map((rel) => readFileSync(join(AGENT_DIR, rel), "utf8")).join("\n");

describe("в словаре i18n нет мёртвых ключей", () => {
  for (const key of Object.keys(messages)) {
    test(`${key} кто-то читает`, () => {
      expect(readsKey(consumerSource, key)).toBe(true);
    });
  }

  test("словарь не пустой — иначе тест бессмысленный", () => {
    expect(Object.keys(messages).length).toBeGreaterThan(0);
  });
});

describe("сверка ищет вызов, а не упоминание", () => {
  test("ключ в комментарии или в чужой строке не считается прочитанным", () => {
    const key = "characters.tone";
    const mention = [
      "// ключ 'characters.tone' пока не используем",
      "const label = 'characters.tone';",
      'log.info("characters.tone");',
    ].join("\n");
    // Прежняя форма сверки такое принимала — отсюда и ложная гарантия.
    expect(mention).toContain(`'${key}'`);
    expect(readsKey(mention, key)).toBe(false);
  });

  test("вызов засчитывается в любой из трёх кавычек и через объект", () => {
    for (const src of [
      "t('characters.tone')",
      't("characters.tone")',
      "t(`characters.tone`)",
      "i18n.t('characters.tone', 'fb')",
      "t(\n  'characters.tone',\n)",
    ]) {
      expect(readsKey(src, "characters.tone")).toBe(true);
    }
  });

  test("точка в ключе не работает как «любой символ»", () => {
    expect(readsKey("t('charactersXtone')", "characters.tone")).toBe(false);
  });
});

describe("список потребителей не устарел", () => {
  test("импортируют lib/i18n ровно те файлы, что перечислены", () => {
    // Сам модуль в обход попадает по имени файла — он себя не импортирует.
    const found = importersOfI18n().filter((p) => p !== "lib/i18n.ts");
    expect(found).toEqual([...CONSUMERS].sort());
  });

  test("обход вообще что-то видит — иначе сверка выше пустая", () => {
    expect(walk(AGENT_DIR).length).toBeGreaterThan(100);
  });
});
