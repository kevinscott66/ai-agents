// Аудит 2026-08-20: ростер команды внутри system-промптов.
//
// `DELEGATION_GUIDE` вклеен во все 12 промптов, а внутри него — список
// «Состав команды и @username». Строка про perm с самого первого коммита
// (7b2abea4, 2026-05-22) несла приписку «(ещё не подключён)» и никогда не
// обновлялась. Роль при этом живая: её заметки лежат в
// `.claude/memory/notes/role-perm/`, а лог переезда на VPS (2026-06-06)
// фиксирует 12/12 ботов.
//
// Цена ошибки не косметическая. Тот же самый DELEGATION_GUIDE двумя абзацами
// выше перечисляет `perm` среди ключей для `assignedTo`, то есть модель видит
// разрешение делегировать и тут же — «бот не подключён». Разрешается это в
// пользу отказа, причём ровно в том сценарии, ради которого роль и заведена:
// разбор `permission_denied`. У самого perm в промпте расписан алгоритм из
// трёх шагов, который в этом случае не запускается никогда.
//
// Тесты ниже держат ростер сцепленным с `CHARACTERS`, а не проверяют один
// вычеркнутый оборот: список ключей, число строк, отсутствие оговорок про
// недоступность и валидность статусов FSM, которые промпт называет.
import { test, expect, describe } from "bun:test";
import { CHARACTERS, type RoleKey } from "../characters/index.ts";
import { TASK_TRANSITIONS, type TaskStatus } from "../lib/task-fsm.ts";

const ROSTER_HEAD = "Состав команды и @username:";

/** Строки ростера из промпта: от заголовка до первой пустой строки. */
function rosterLines(system: string): string[] {
  const after = system.split(ROSTER_HEAD)[1] ?? "";
  const out: string[] = [];
  for (const line of after.split("\n")) {
    // Первая строка — хвост заголовка, она пустая; пустой считаем только ту,
    // что пришла уже после начала списка.
    if (out.length === 0 && !line.startsWith("- ")) continue;
    if (line.trim() === "") break;
    if (!line.startsWith("- ")) break;
    out.push(line);
  }
  return out;
}

const KEYS = CHARACTERS.map((c) => c.key);

describe("ростер доезжает до каждой роли", () => {
  test("все 12 промптов содержат состав команды", () => {
    expect(CHARACTERS.length).toBe(12);
    for (const c of CHARACTERS) {
      expect(c.system).toContain(ROSTER_HEAD);
    }
  });

  test("во всех промптах ростер одинаковый", () => {
    const variants = new Set(
      CHARACTERS.map((c) => rosterLines(c.system).join("\n")),
    );
    expect(variants.size).toBe(1);
  });
});

describe("ростер описывает ровно текущую команду", () => {
  const lines = rosterLines(CHARACTERS[0].system);

  test("строк столько же, сколько ролей", () => {
    expect(lines.length).toBe(CHARACTERS.length);
  });

  test("у каждой строки свой @username", () => {
    const handles = lines.map((l) => l.match(/@[A-Za-z0-9_]+/)?.[0] ?? "");
    expect(handles.every(Boolean)).toBe(true);
    expect(new Set(handles).size).toBe(handles.length);
  });

  test("ни одна роль не помечена недоступной", () => {
    // Оговорка в ростере читается моделью как запрет делегировать, а проверить
    // её правдивость из промпта нельзя: роль поднимается по наличию токена в
    // env (orchestrator-team.ts), а не по тексту.
    for (const line of lines) {
      expect(line).not.toMatch(/не подключ|не работает|TODO|пока нет|отключ/i);
    }
  });

  test("в строках нет скобочных примечаний", () => {
    // Более широкая сеть, чем список слов выше: любое «(…)» в ростере — это
    // оговорка про роль, а ростер должен быть просто списком адресов.
    expect(lines.filter((l) => /\(/.test(l))).toEqual([]);
  });
});

describe("список ключей для assignedTo не разъезжается с CHARACTERS", () => {
  const line = CHARACTERS[0].system.match(
    /Ключи ролей \(assignedTo\): ([^\n]+)/,
  );

  test("строка с ключами есть", () => {
    expect(line).not.toBeNull();
  });

  test("перечислены ровно ключи CHARACTERS, в том же порядке", () => {
    const listed = line![1]
      .replace(/\.\s*$/, "")
      .split(",")
      .map((s) => s.trim());
    expect(listed).toEqual(KEYS as RoleKey[]);
  });
});

describe("статусы FSM в промпте существуют на самом деле", () => {
  test("UPDATE_TASK_STATUS называет только настоящие статусы", () => {
    const line = CHARACTERS[0].system.match(/UPDATE_TASK_STATUS \{[^\n]+/);
    expect(line).not.toBeNull();
    const named: string[] = [
      ...(line![0].match(/[a-z_]+(?=→|\/|\))/g) ?? []),
      ...(line![0].match(/(?<=→|\/)[a-z_]+/g) ?? []),
    ];
    const real = new Set(Object.keys(TASK_TRANSITIONS) as TaskStatus[]);
    const invented = [...new Set(named)].filter((s) => !real.has(s as TaskStatus));
    expect(invented).toEqual([]);
  });
});
