/**
 * Аудит 2026-09-11, круг 44: сторожа круга 20 и круга 22 не смотрят в доки.
 *
 * Оба правила — «координата обязана указывать хоть на что-то» и «имя в
 * обратных кавычках обязано найтись» — заведены для комментариев в исходниках
 * и обходят markdown стороной. Между тем README и ONBOARDING читают РАНЬШЕ
 * кода: PROMPT-NEW-AGENT велит начать с них, а оператор ставит систему по
 * блоку «minimum configuration», не открывая ни одного `.ts`. Ложь здесь
 * дороже, чем в докстроке рядом с кодом, — её нечем проверить на месте.
 *
 * Что нашлось при заведении проверки, всё — про переменные окружения:
 *
 *  • ALLOWED_CHAT_IDS не существует в коде вовсе (README, ONBOARDING —
 *    дважды). Настоящее имя — `TELEGRAM_ALLOWED_GROUP_IDS`. Цена не
 *    косметическая: граница fail-closed, поэтому оператор, выполнивший
 *    инструкцию буквально, получает молчащих ботов — ровно тот симптом,
 *    который абзац ONBOARDING обещал объяснить («частая причина „не
 *    работает“»). Документ указывал на себя как на лечение и был причиной.
 *  • TG_API_ID / TG_API_HASH / TG_PHONE — та же беда в блоке MTProto:
 *    живут `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_USERBOT_PHONE`.
 *  • `.env.example` называл `TELEGRAM_ALLOWED_GROUP_IDS` и
 *    `MINIAPP_ALLOWED_USER_IDS` словом «Optional», хотя пустой список у
 *    `isAllowlisted` запрещает ВСЕМ. Соседний `MINIAPP_ALLOWED_ORIGINS` в том
 *    же файле описан правильно и прямо помечен «Пусто = НЕ fail-closed» — то
 *    есть правило в файле есть и действует на одном месте из трёх.
 *  • lib/actions.ts в таблице модулей — файла нет; перечень действий
 *    (`ACTION_TYPES`) лежит в `permissions.ts`, которая в той же таблице
 *    строкой ниже.
 *  • `deploy/README.md` отправлял за «живой конфигурацией» в
 *    `.claude/memory/notes/…`, которого в репозитории нет и не будет: репо
 *    публичное, инфраструктурные факты держат снаружи.
 *
 * (Мёртвые имена выше намеренно без обратных кавычек — по правилу круга 22:
 * кавычки обещают, что символ найдётся.)
 *
 * Числа в доках — отдельный вид гнили: «53k lines», «798 test files», «1245
 * LOC» были верны в день написания и молча разошлись с деревом (210k, 900,
 * 2096). Правило здесь то же, что у координаты строки: либо число убрать,
 * либо сделать проверяемым. Убрано в ONBOARDING, сделано проверяемым в README
 * — формулировка переписана на «не меньше чем», и тест держит её снизу.
 * Монотонная граница не ломается от роста дерева: упасть она может только от
 * УДАЛЕНИЯ, а это как раз тот случай, когда на цифру стоит взглянуть руками.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isAllowlisted } from "../lib/allowlist.ts";

const REPO = join(import.meta.dir, "..", "..");
const doc = (p: string) => readFileSync(join(REPO, p), "utf8");

/** Документы для оператора и новичка. Память ролей (agent/memory) — не документ, а данные. */
const DOCS = ["README.md", "agent/ONBOARDING.md", "agent/.env.example"];

const tracked = spawnSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8" })
  .stdout.split("\n")
  .filter(Boolean);

/** Исходники, в которых имя переменной обязано найтись, если оно живое. */
const CODE = /\.(ts|tsx|sh|yml|yaml|service|timer|json)$/;
const haystack = tracked
  .filter((p) => CODE.test(p) && !p.startsWith("site/web/"))
  .map((p) => {
    try {
      return readFileSync(join(REPO, p), "utf8");
    } catch {
      return "";
    }
  })
  .join("\n");

/** Имя переменной окружения: из строки `KEY=` или из обратных кавычек. */
function envNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]{3,})=/gm)) out.add(m[1]!);
  for (const m of text.matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)) out.add(m[1]!);
  return out;
}

describe("документы оператора не называют мёртвых имён", () => {
  test("дерево прочиталось — иначе сторож молчит ни о чём", () => {
    expect(tracked.length).toBeGreaterThan(100);
    expect(haystack.length).toBeGreaterThan(100_000);
  });

  test("каждая переменная окружения из доков есть в коде", () => {
    const dead: string[] = [];
    for (const d of DOCS) {
      for (const name of envNames(doc(d))) {
        if (!new RegExp(`\\b${name}\\b`).test(haystack)) dead.push(`${d}: ${name}`);
      }
    }
    // Когда падает: не заводить переменную в коде под документ, а назвать в
    // документе ту, которую код читает на самом деле.
    expect(dead).toEqual([]);
  });

  test("каждый файл, названный в доках, существует", () => {
    const byPath = new Set(tracked);
    const dead: string[] = [];
    for (const d of DOCS) {
      for (const m of doc(d).matchAll(/`([A-Za-z0-9_./-]+\.(?:ts|tsx|sh|md))`/g)) {
        const ref = m[1]!;
        const ok =
          byPath.has(ref) ||
          tracked.some((p) => p.endsWith("/" + ref)) ||
          existsSync(join(REPO, ref));
        if (!ok) dead.push(`${d}: ${ref}`);
      }
    }
    expect(dead).toEqual([]);
  });
});

describe("fail-closed граница названа fail-closed", () => {
  // Список ровно тот, чьи значения уходят в isAllowlisted. Проверка держит не
  // текст сам по себе, а соответствие текста поведению функции.
  const FAIL_CLOSED = ["TELEGRAM_ALLOWED_GROUP_IDS", "MINIAPP_ALLOWED_USER_IDS"];

  test("предпосылка: пустой список действительно запрещает всем", () => {
    expect(isAllowlisted("-100123", [])).toBe(false);
    expect(isAllowlisted("-100123", undefined)).toBe(false);
    expect(isAllowlisted("-100123", ["-100123"])).toBe(true);
  });

  test("в .env.example эти переменные не названы необязательными", () => {
    const lines = doc("agent/.env.example").split("\n");
    for (const name of FAIL_CLOSED) {
      const i = lines.findIndex((l) => l.startsWith(`${name}=`));
      expect(i).toBeGreaterThan(-1);
      // Описание переменной — её строка плюс продолжения комментария под ней.
      let block = lines[i]!;
      for (let k = i + 1; k < lines.length && /^\s+#/.test(lines[k]!); k++) {
        block += "\n" + lines[k];
      }
      expect(block.toLowerCase()).not.toContain("optional");
      expect(block.toLowerCase()).toContain("fail-closed");
    }
  });
});

describe("числа в README проверяемы", () => {
  const text = doc("README.md");
  // Разметка переносит строки по ширине, и «more\nthan 900» — та же фраза, что
  // «more than 900». Утверждения ниже про текст, а не про раскладку абзаца.
  const flat = text.replace(/\s+/g, " ");

  test("заявленный объём — нижняя граница, а не снимок дня", () => {
    const loc = tracked
      .filter((p) => /\.(ts|tsx)$/.test(p) && !p.startsWith("site/web/"))
      .reduce((n, p) => n + readFileSync(join(REPO, p), "utf8").split("\n").length, 0);
    const testFiles = tracked.filter((p) => /\/tests\/.*\.ts$/.test(p)).length;

    const locClaim = /over (\d+)k lines of TypeScript/.exec(flat);
    const filesClaim = /more than (\d+) test files/.exec(flat);
    expect(locClaim).not.toBeNull();
    expect(filesClaim).not.toBeNull();
    expect(loc).toBeGreaterThan(Number(locClaim![1]) * 1000);
    expect(testFiles).toBeGreaterThan(Number(filesClaim![1]));
  });

  test("снимков дня в README не осталось", () => {
    // Прежняя формулировка: «53k lines of TypeScript, 798 test files».
    // Число без «over»/«more than» тухнет молча — такого тут быть не должно.
    // `\b` обязателен: без него `\d+` встаёт и на «00k» внутри «200k», и
    // ретроспекция смотрит на «2», а не на слово перед числом.
    expect(flat).not.toMatch(/(?<!over )\b\d+k lines of TypeScript/);
    expect(flat).not.toMatch(/(?<!more than )\b\d+ test files/);
  });
});
