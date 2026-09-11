/**
 * Аудит 2026-08-11: гейт разрешений должен быть один.
 *
 * В lib/actions.ts жила функция `gatedAction()` — вторая реализация того же
 * решения «allow / approval / deny». Продакшен её не звал ни из одного места
 * (только тесты c3/c4), но она выглядела живой и заведомо более слабой:
 *
 *  • без `payloadForcesApproval` — то есть действия «от лица владельца»
 *    (via_userbot) и bypass-запуск Claude на Mac прошли бы БЕЗ человека. Ровно
 *    этот инвариант чинили дважды (SEC-4, T-602), и 2026-08-08 отдельно сводили
 *    две разошедшиеся копии в одну функцию;
 *  • без rate-limit и валидации payload — то есть кривой payload садился бы в
 *    очередь апрувов, что живой путь специально предотвращает;
 *  • `createApproval({ chatId: params.chatId ?? 0 })` — апрув без чата уезжал
 *    на доску несуществующего чата 0, мимо границы арендатора.
 *
 * Хуже кода была подпись к нему: комментарий в lib/telegram-actions.ts называл
 * `gatedAction()` тем самым местом, где проверяются права. Читатель, пришедший
 * проверить гейт, читал бы мёртвую слабую копию и считал вопрос закрытым.
 *
 * Инвариант: `evaluateGate` зовут только те места, где это осознанное решение.
 * Тест структурный намеренно — он ловит не поведение (у мёртвого кода его нет),
 * а появление ЕЩЁ ОДНОЙ двери к тому же решению.
 *
 * Аудит 2026-09-11: инвариант формулировался про «места» вообще, а обход шёл
 * по одному `lib/`. Вызовов вне него сегодня нет ни одного, так что дыра была
 * не в коде, а в стороже: вторая дверь, открытая из `tools/` или
 * `orchestrator/`, прошла бы мимо теста, который обещает её ловить. Сторож,
 * отвечающий про часть дерева и молчащий об этом, хуже отсутствующего —
 * поэтому деревья перечислены явно, а ключи `ALLOWED` стали путями от корня
 * `agent/`, чтобы `lib/commands.ts` и гипотетический `tools/commands.ts` не
 * схлопывались в одну запись.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const AGENT = new URL("../", import.meta.url).pathname;

/** Боевые деревья целиком: дверь к гейту из любого из них — вторая дверь. */
const SOURCE_ROOTS = ["lib", "miniapp/src", "tools", "orchestrator", "mac-daemon"];

/**
 * Кто имеет право звать evaluateGate напрямую, и почему именно он.
 * Добавление сюда — осознанный шаг, который придётся объяснить в ревью.
 */
const ALLOWED = new Map<string, string>([
  [
    "lib/action-dispatch.ts",
    "единственный живой путь: rate-limit → payloadForcesApproval → gate → " +
      "валидация payload → строка approval",
  ],
  [
    "lib/commands.ts",
    "команды владельца в чате (/approve и соседи) — решение принимает человек",
  ],
  [
    "lib/self-diag.ts",
    "нужен ОТВЕТ гейта без побочных эффектов: gateOrDispatch на 'approval' " +
      "завёл бы строку в очереди (объяснено в шапке self-diag.ts)",
  ],
  ["lib/permissions.ts", "здесь она и определена"],
]);

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Вызовы, а не упоминания: комментарии и импорты не считаем. */
function callsEvaluateGate(src: string): boolean {
  return /(?<!\/\/.*)\bevaluateGate\s*\(/.test(
    src
      .split("\n")
      .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//"))
      .join("\n"),
  );
}

/**
 * Каталог читается ОДИН раз на файл, а не заново в каждом тесте.
 *
 * Три теста ниже обходили `lib/` и читали каждый `.ts` целиком — то есть один
 * и тот же обход шёл трижды за файл. Само по себе это переживаемо, но в полном
 * прогоне на 392 файла тела упирались в дефолтные 5 с бун и краснели
 * «timed out»: результат зависел от загруженности машины, а не от кода
 * (замер: 1.4-1.7 с на тест вхолостую, 5.5 с под нагрузкой). Кэш убирает
 * причину, а не поднимает порог.
 *
 * Читаем на уровне модуля, а не в `beforeAll`: тест здесь структурный, он
 * смотрит на исходники, а те за время прогона не меняются.
 */
const SOURCES: Array<{ rel: string; src: string }> = SOURCE_ROOTS.flatMap((r) =>
  walk(join(AGENT, r)).map((f) => ({
    rel: f.slice(AGENT.length),
    src: readFileSync(f, "utf8"),
  })),
);

/** Файлы, которые действительно ЗОВУТ evaluateGate. */
const CALLERS = SOURCES.filter((f) => callsEvaluateGate(f.src)).map(
  (f) => f.rel,
);

describe("гейт разрешений — один", () => {
  test("обход видит все боевые деревья, а не одно", () => {
    // Пустой или усечённый обход сделал бы проверки ниже зелёными вхолостую —
    // ровно тот отказ, которым сторож жил до аудита 2026-09-11.
    expect(SOURCES.length).toBeGreaterThan(150);
    for (const root of SOURCE_ROOTS) {
      expect(SOURCES.some((f) => f.rel.startsWith(root + "/"))).toBe(true);
    }
  });

  test("evaluateGate зовут только объяснённые места", () => {
    const offenders = CALLERS.filter((rel) => !ALLOWED.has(rel));

    expect(offenders).toEqual([]);
  });

  test("мёртвая копия gatedAction не вернулась", () => {
    const all = SOURCES.map((f) => f.src).join("\n");
    expect(all).not.toMatch(/function gatedAction\b/);
  });

  test("список разрешённых не разъехался с реальностью", () => {
    // Обратная сторона: если файл из ALLOWED перестал звать гейт, запись
    // протухла и защищает пустоту.
    const calling = new Set(CALLERS);
    for (const rel of ALLOWED.keys()) expect(calling.has(rel)).toBe(true);
  });
});

describe("подпись к гейту не врёт", () => {
  test("telegram-actions.ts отправляет читателя к живому пути", () => {
    const src = readFileSync(join(AGENT, "lib/telegram-actions.ts"), "utf8");
    // Аудит 2026-08-12: тут проверялось «dispatchAction()», но описанной рядом
    // цепочки (rate-limit → payloadForcesApproval → evaluateGate → валидация →
    // approval) в ней нет ни строчки: dispatchAction — исполнитель, switch по
    // типам, он вызывается уже ПОСЛЕ гейта. Цепочка целиком — в gateOrDispatch.
    // То есть инвариант закреплял вторую неверную ссылку подряд.
    expect(src).toContain("gateOrDispatch()");
    // До фикса 2026-08-11 здесь стояло «gatedAction() в tools-schema.ts» —
    // функции с таким именем в том файле не было никогда.
    expect(src).not.toMatch(/gatedAction\(\) в tools-schema/);
    // И имя должно существовать среди экспортов диспетчера, а не быть выдумкой.
    const disp = readFileSync(join(AGENT, "lib/action-dispatch.ts"), "utf8");
    expect(disp).toMatch(/export async function gateOrDispatch\b/);
  });
});
