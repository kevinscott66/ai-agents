/**
 * Аудит 2026-08-28: DISPATCH_ONLY у CREATE_DIAGNOSTIC_TASK объяснялся неправдой.
 *
 * `DISPATCH_ONLY_ACTIONS` — это словарь «почему у действия нет тула». У
 * CREATE_DIAGNOSTIC_TASK там стояло «ставится движком self-healing
 * автоматически». Движок self-healing его не ставит: на catch-пути
 * (`action-dispatch.ts`, T-704) он зовёт библиотечный `createDiagnosticTask()`
 * из `diagnostic.ts` НАПРЯМУЮ, минуя диспетчер. Через диспетчер это действие
 * не приходит ниоткуда: тула нет (это и значит DISPATCH_ONLY), а
 * `dispatchAction("CREATE_DIAGNOSTIC_TASK", …)` не пишет ни один файл.
 *
 * То есть `handleCreateDiagnosticTask` — вместе с проверкой чужого чата,
 * которую туда поставил отдельный аудит, — в проде не исполняется ни разу.
 *
 * Заголовок самого модуля утверждал обратное («lets ANY agent explicitly
 * request an investigation»), и то же повторял комментарий на ветке
 * диспетчера. Три места, и все три расходились с кодом в РАЗНЫЕ стороны:
 * читатель, поверивший любому из них, сделает неверный вывод — например,
 * снимет прямой вызов на catch-пути, решив, что диспетчер его дублирует.
 *
 * Тест фиксирует факт, а не намерение: если тул однажды заведут или ветку
 * начнут диспатчить — упадёт здесь, и документацию поправят вместе с кодом.
 * Само действие не удаляется: T-701 построил его сознательно, а решение
 * «выдать роль модели или снести» — за владельцем.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DISPATCH_ONLY_ACTIONS, ACTION_TYPES } from "../lib/permissions.ts";

const ROOT = new URL("../", import.meta.url).pathname;
const ACTION = "CREATE_DIAGNOSTIC_TASK";

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "tests") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) tsFiles(p, acc);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) acc.push(p);
  }
  return acc;
}

const SOURCES = [join(ROOT, "lib"), join(ROOT, "orchestrator")].flatMap((d) =>
  tsFiles(d).map((p) => [p.slice(ROOT.length), readFileSync(p, "utf-8")] as const),
);

const PERMS = readFileSync(join(ROOT, "lib/permissions.ts"), "utf-8");
const DISPATCH = readFileSync(join(ROOT, "lib/action-dispatch.ts"), "utf-8");
const HANDLER = readFileSync(join(ROOT, "lib/dispatch/diagnostic-action.ts"), "utf-8");

describe("предпосылки", () => {
  test("действие объявлено и помечено dispatch-only", () => {
    expect((ACTION_TYPES as readonly string[]).includes(ACTION)).toBe(true);
    expect(Object.keys(DISPATCH_ONLY_ACTIONS)).toContain(ACTION);
  });

  test("ветка диспетчера существует — это мёртвый путь, а не отсутствующий", () => {
    expect(DISPATCH).toContain(`case "${ACTION}": {`);
    expect(HANDLER).toContain("export function handleCreateDiagnosticTask");
  });
});

describe("через диспетчер это действие не приходит ниоткуда", () => {
  test("ни один файл lib/ и orchestrator/ его не диспатчит", () => {
    const callers = SOURCES.filter(([, src]) =>
      new RegExp(`dispatch(Action|AndAudit)\\(\\s*["'\`]${ACTION}`).test(src),
    ).map(([p]) => p);
    expect(callers).toEqual([]);
  });

  test("движок self-healing зовёт библиотеку напрямую, не диспетчер", () => {
    expect(DISPATCH).toMatch(
      /import \{[^}]*\bcreateDiagnosticTask\b[^}]*\} from "\.\/diagnostic\.ts"/s,
    );
    expect(DISPATCH).toContain("createDiagnosticTask({");
    // Ветка диспетчера ровно одна, и она зовёт другой символ — хендлер.
    expect(DISPATCH.split('case "CREATE_DIAGNOSTIC_TASK": {').length - 1).toBe(1);
  });
});

describe("документация говорит то, что есть", () => {
  test("причина dispatch-only больше не ссылается на движок self-healing", () => {
    const reason = DISPATCH_ONLY_ACTIONS[ACTION];
    expect(reason).not.toContain("ставится движком");
    expect(reason).toContain("createDiagnosticTask() напрямую");
  });

  test("остальные причины dispatch-only не тронуты", () => {
    expect(DISPATCH_ONLY_ACTIONS.GRANT_PERMISSION).toContain("privilege escalation");
    expect(DISPATCH_ONLY_ACTIONS.SPAWN_ROLE).toContain("approved dispatch");
    expect(Object.keys(DISPATCH_ONLY_ACTIONS).length).toBe(6);
  });

  test("заголовок модуля не обещает вызов любым агентом", () => {
    expect(HANDLER).not.toContain("lets ANY agent explicitly request");
    expect(HANDLER).toContain("Тула у действия нет");
  });

  test("комментарий на ветке диспетчера — тоже", () => {
    expect(DISPATCH).not.toContain("T-701: explicit diagnostic-task creation by any agent.");
    expect(DISPATCH).toContain("Мёртвая ветка");
  });

  test("сам словарь остаётся замороженным", () => {
    expect(Object.isFrozen(DISPATCH_ONLY_ACTIONS)).toBe(true);
  });
});
