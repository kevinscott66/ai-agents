/**
 * Бейдж статуса без своего правила — белый текст на белом фоне.
 *
 * `.badge` в styles.css задаёт `color: #fff` и НЕ задаёт background: цвет
 * приходит только из модификатора (`.badge.ok`, `.badge.error`, …). Модификатор
 * подставляется из строки статуса прямо в className, то есть промах по имени
 * класса ничего не ломает и ничего не подсвечивает — он просто оставляет
 * элемент без фона. А фон страницы по умолчанию `--bg: #ffffff` (styles.css:4),
 * так что белым по белому.
 *
 * Аудит 2026-08-12 нашёл этим ровно то, ради чего проверка и пишется:
 *
 *   • Agents.tsx:332 — `action.status === "ok" ? "success" : …`. Правила
 *     `.badge.success` в файле нет вообще (есть `.btn.success`, `.toast.success`,
 *     `.action-btn.success` — другие компоненты). То есть в карточке агента
 *     статус УСПЕШНОГО действия — самый частый случай — не виден. Зелёное
 *     правило называется `.badge.done, .badge.ok, .badge.approved`.
 *
 *   • `expired` у заявок на одобрение — статус появился в этом же аудите
 *     (lib/approvals.ts), лейбл «истекло» в labels.ts уже был, правила нет.
 *
 * Проверяем две вещи, и вторая важнее первой: (1) каждый модификатор, который
 * код реально подставляет, имеет правило; (2) у `.badge` есть фон по умолчанию.
 * Первое — про сегодняшние промахи, второе — про завтрашние: список статусов
 * растёт на бэкенде, а CSS про это не узнаёт никогда. Пока дефолта нет, любой
 * новый статус доезжает до прода невидимым.
 */
import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "miniapp", "src");
const CSS = readFileSync(join(SRC, "styles.css"), "utf8");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Модификаторы, которые код подставляет вторым классом после `badge`. */
function usedBadgeModifiers(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (mod: string, where: string) => {
    if (!mod || mod === "badge") return;
    const list = found.get(mod) ?? [];
    if (!list.includes(where)) list.push(where);
    found.set(mod, list);
  };
  for (const file of tsxFiles(SRC)) {
    const src = readFileSync(file, "utf8");
    const where = file.slice(SRC.length + 1);

    // Статический вариант: className="badge pending"
    for (const m of src.matchAll(/className="badge ([a-z_ ]+)"/g)) {
      for (const part of m[1].split(/\s+/)) add(part.trim(), where);
    }

    // Шаблонный вариант: className={`badge ${ … }`} — внутри выражения
    // интересны строковые литералы, это и есть подставляемые имена классов.
    let idx = src.indexOf("badge ${");
    while (idx !== -1) {
      const end = src.indexOf("`", idx);
      const expr = src.slice(idx, end === -1 ? src.length : end);
      for (const lit of expr.matchAll(/"([a-z_]+)"/g)) add(lit[1], where);
      idx = src.indexOf("badge ${", idx + 1);
    }
  }
  return found;
}

/** Есть ли селектор `.badge.<mod>` (в том числе в списке через запятую). */
function hasBadgeRule(mod: string): boolean {
  return new RegExp(`\\.badge\\.${mod}\\b`).test(CSS);
}

describe("бейджи статусов читаемы", () => {
  test("у .badge есть фон по умолчанию — иначе неизвестный статус невидим", () => {
    // Базовый блок: от `.badge {` до первой `}`.
    const start = CSS.search(/^\.badge\s*\{/m);
    expect(start).toBeGreaterThanOrEqual(0);
    const base = CSS.slice(start, CSS.indexOf("}", start));
    expect(base).toContain("color");
    expect(base).toMatch(/background(-color)?\s*:/);
  });

  test("каждый подставляемый модификатор имеет правило в styles.css", () => {
    const used = usedBadgeModifiers();
    // Ловит только литералы: `badge ${action.status}` сюда не попадает и попасть
    // не может — статус известен в рантайме. Пропуски того вида закрывает фон по
    // умолчанию из теста выше, здесь же — только явно написанные имена классов.
    expect(used.size).toBeGreaterThanOrEqual(3); // проверка сама себя не обманывает
    const missing: string[] = [];
    for (const [mod, where] of used) {
      if (!hasBadgeRule(mod)) missing.push(`${mod} (${where.join(", ")})`);
    }
    expect(missing).toEqual([]);
  });

  test("карточка агента красит статусы тем же словарём, что Logs и Dashboard", () => {
    // Регрессия Agents.tsx:332: "ok" → класс "success", которого у бейджа нет.
    // Чинится не добавлением алиаса, а отказом от своей перекодировки: у
    // каждого ActionStatus правило уже есть, а собственный словарь на третьей
    // странице — это ещё и "forbidden" в сером вместо красного.
    const agents = readFileSync(join(SRC, "pages", "Agents.tsx"), "utf8");
    expect(agents).toContain("badge ${action.status}");
    // Именно как модификатор бейджа: у кнопок и тостов `success` — свой,
    // законный класс (.btn.success, .toast.success, .action-btn.success).
    expect([...usedBadgeModifiers().keys()]).not.toContain("success");
  });

  test("терминальные статусы заявок на одобрение покрашены", () => {
    // lib/approvals.ts: pending | approved | rejected | failed | expired.
    for (const s of ["pending", "approved", "rejected", "failed", "expired"]) {
      expect({ status: s, hasRule: hasBadgeRule(s) }).toEqual({
        status: s,
        hasRule: true,
      });
    }
  });
});
