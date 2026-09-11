/**
 * Аудит 2026-08-21: список отказов «по правилам» разошёлся с теми, кто их
 * производит.
 *
 * DELEGATION_REFUSALS (lib/diagnostic.ts) — это whitelist текстов, при которых
 * самодиагностика НЕ заводится: агент попросил то, что правила запрещают, чинить
 * тут нечего. Проверено по источникам:
 *
 * Все живые производители — в одной ветке: `case "DELEGATE_TO_ROLE"` внутри
 * `dispatchAction` (lib/action-dispatch.ts). Столбец «сколько мест» считается
 * grep'ом по самому тексту, номеров строк здесь нет намеренно — см. ниже.
 *
 *   | текст                          | мест | был ли в списке |
 *   |--------------------------------|------|-----------------|
 *   | cannot delegate to self        |  2   | ✅              |
 *   | delegation cycle               |  3   | ✅              |
 *   | delegation depth exceeded      |  0   | мёртвая строка  |
 *   | no_available_agent: <role>     |  1   | ❌              |
 *   | delegate_skipped: <причина>    |  1   | ❌              |
 *
 * `delegation depth exceeded` осталась от второго потолка `p._depth >=
 * MAX_HANDOFF_DEPTH`, снесённого аудитом 2026-08-10 (комментарий на месте
 * удаления — action-dispatch.ts). Гейт не срабатывал никогда, текст никто
 * не пишет.
 *
 * `delegate_skipped:` целиком в исходнике не ищется: он склеивается как
 * `delegate_${outcome.status}` из статуса `HandoffOutcome`. В круге 29 это
 * едва не стоило ложного вывода «строка мертва» — grep по литералу находит
 * только сам список.
 *
 * Круг 29: в таблице стояли номера строк — 812, 826, 851, 859, 866, 819, 1038. Ни один
 * не указывал на своё место (настоящие разъехались на сотни строк), и не заметил этого
 * ни один сторож: три из семи записаны голым «двоеточие плюс число», без имени файла, а
 * такая координата не видна ни audit-2026-09-11-stale-line-coordinates (ему нечего
 * разрешать), ни audit-2026-09-11-symbol-plus-coordinate (перед ней нет символа в
 * кавычках). Замер круга 29 по дереву: таких голых координат было 39, и цель у них
 * задана прозой — ближайшее имя файла в том же абзаце угадывает её верно 32 раза из 33.
 * Сторож, ошибающийся в цели, — это ровно тот дефект, который круг 29 чинил в
 * `resolveTarget`, поэтому проверку решено не заводить, а форму — не употреблять: у
 * координаты должно быть имя файла, иначе её место — здесь, в списке того, что протухло
 * молча.
 *
 * А вот две реально существующие причины в списке отсутствовали, и обе — ровно
 * тот шум, ради которого правило и писалось. Замер (dispatchAndAudit,
 * DELEGATE_TO_ROLE на роль, у которой и цель, и оба фолбэка остановлены):
 *
 *   TASK: pending | aieng        | Tool error: DELEGATE_TO_ROLE
 *   TASK: pending | orchestrator | [diagnostic] unknown: DELEGATE_TO_ROLE
 *
 * Две строки на доске просят починить сработавшую защиту. Владелец сам поставил
 * роль на паузу — это не поломка. Проект уже принял это решение в другом месте
 * воронки: `respondAs` в handoff.ts при остановленной цели возвращает `skipped`, а не
 * `failed`, с комментарием «сам он молчит, а делегирование его будит».
 *
 * Чего здесь СОЗНАТЕЛЬНО не сделано: `no_available_agent` не занесён в список
 * целиком. Тот же текст выдаётся, когда все кандидаты недоступны ПО ЗДОРОВЬЮ —
 * то есть боты мертвы. Это поломка, её надо чинить, и диагностика на неё
 * заводиться обязана. Ровно на этой ошибке уже обжигались: первая редакция
 * правила (2026-08-02) гасила SPLIT_TASK по типу и молча съедала настоящие
 * поломки с текстом `no roles accepted` (см. докстроку DELEGATION_REFUSALS).
 * Поэтому причину теперь называет производитель: политика (`stopped`) даёт
 * маркер в тексте, здоровье — нет.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isByDesignRefusal, shouldSkipSelfDiag } from "../lib/diagnostic.ts";
import { dispatchAndAudit } from "../lib/action-dispatch.ts";
import { allCandidatesStopped } from "../lib/role-skills.ts";
import { _resetRateLimits } from "../lib/rate-limits.ts";
import { listTasksByChat } from "../lib/tasks.ts";
import type { HandoffDeps, RespondAsOpts } from "../lib/handoff.ts";
import type { RunningBot } from "../lib/types.ts";
import type { HealthSnapshot } from "../lib/health.ts";
import { cleanupChat, saveAutonomy, restoreAutonomy } from "./_helpers.ts";

const TEST_CHAT = -1_000_9291;

let savedGlobal = saveAutonomy();

beforeEach(() => {
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
  savedGlobal = saveAutonomy();
});

afterEach(() => {
  restoreAutonomy(savedGlobal);
  _resetRateLimits();
  cleanupChat(TEST_CHAT);
});

function fakeBot(key: string): RunningBot {
  return {
    def: { key: key as never, name: key, envToken: "", system: "" } as never,
    bot: { telegram: {} } as never,
    username: `${key}_bot`,
    id: 100,
  };
}

function fakeDeps(): HandoffDeps {
  return { anthropic: {} as never, model: "test", historyLimit: 10, bots: [] };
}

function silentSnap(key: string): HealthSnapshot {
  return {
    agentKey: key,
    username: `${key}_bot`,
    alive: false,
    lastOkAt: null,
    lastErrorAt: Date.now(),
    consecutiveFailures: 5,
    lastError: "silent",
  };
}

/** backend + оба его фолбэка (ROLE_FALLBACKS.backend = tgdev, aieng). */
const DOWN = ["backend", "tgdev", "aieng"];

function delegateToDownBackend(mode: "stopped" | "unhealthy") {
  const stub = mock(async (_o: RespondAsOpts, _d: HandoffDeps) => "");
  return dispatchAndAudit(
    "DELEGATE_TO_ROLE",
    { role: "backend", task: "x" },
    {
      agentKey: "pm",
      chatId: TEST_CHAT,
      resolveAgent: (k) => fakeBot(k),
      handoffDeps: fakeDeps(),
      respondAsImpl: stub as never,
      availability:
        mode === "stopped"
          ? { isStopped: (k) => DOWN.includes(k), getHealth: () => undefined }
          : {
              isStopped: () => false,
              getHealth: (k) => (DOWN.includes(k) ? silentSnap(k) : undefined),
            },
    },
  );
}

describe("остановленная роль — отказ по правилам, а не поломка", () => {
  test("замер: доска остаётся чистой", async () => {
    const res = await delegateToDownBackend("stopped");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no_available_agent/);
    expect(listTasksByChat(TEST_CHAT).length).toBe(0);
  });

  test("производитель называет причину в тексте", async () => {
    const res = await delegateToDownBackend("stopped");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("all candidates stopped");
  });

  test("shouldSkipSelfDiag гасит этот текст", () => {
    expect(
      shouldSkipSelfDiag(
        "DELEGATE_TO_ROLE",
        "no_available_agent: backend (all candidates stopped)",
      ),
    ).toBe(true);
  });
});

describe("мёртвые боты — поломка, диагностика обязана заводиться", () => {
  test("замер: две строки на доске остаются", async () => {
    const res = await delegateToDownBackend("unhealthy");
    expect(res.ok).toBe(false);
    const rows = listTasksByChat(TEST_CHAT);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.assigned_to).sort()).toEqual([
      "aieng",
      "orchestrator",
    ]);
  });

  test("текст без маркера политики", async () => {
    const res = await delegateToDownBackend("unhealthy");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).not.toContain("all candidates stopped");
  });

  test("shouldSkipSelfDiag НЕ гасит текст без маркера", () => {
    expect(
      shouldSkipSelfDiag("DELEGATE_TO_ROLE", "no_available_agent: backend"),
    ).toBe(false);
  });

  test("смесь «одна на паузе, вторая мертва» считается поломкой", () => {
    // Есть кого чинить — значит текст без маркера, диагностика заводится.
    expect(
      allCandidatesStopped("backend", {
        isStopped: (k) => k === "backend",
        getHealth: (k) => (DOWN.includes(k) ? silentSnap(k) : undefined),
      }),
    ).toBe(false);
    expect(
      allCandidatesStopped("backend", {
        isStopped: (k) => DOWN.includes(k),
        getHealth: () => undefined,
      }),
    ).toBe(true);
  });
});

describe("delegate_skipped — второй пропущенный производитель", () => {
  test("остановленная цель в воронке handoff", () => {
    expect(
      shouldSkipSelfDiag(
        "DELEGATE_TO_ROLE",
        "delegate_skipped: роль backend остановлена (paused)",
      ),
    ).toBe(true);
  });

  test("исчерпанный бюджет вызовов ролей", () => {
    expect(
      shouldSkipSelfDiag(
        "DELEGATE_TO_ROLE",
        "delegate_skipped: исчерпан бюджет вызовов ролей на ход (6)",
      ),
    ).toBe(true);
  });

  test("delegate_failed остаётся поломкой", () => {
    // `failed` производит и настоящий провал роли (пустой ответ, исключение),
    // и гасить его нельзя.
    expect(
      shouldSkipSelfDiag(
        "DELEGATE_TO_ROLE",
        "delegate_failed: delegate returned empty reply",
      ),
    ).toBe(false);
  });
});

describe("мёртвая строка списка", () => {
  // Саму строку из списка убирает audit-2026-08-20-refusal-list-phantom.test.ts
  // (PR #517) — там же карта «запись → производитель». Здесь остаётся то, чего
  // та карта не покрывает: фантом не должен вернуться НИГДЕ в lib/.
  test("текст `depth exceeded` не производит никто в lib/", () => {
    const files = readdirSync("lib", { recursive: true, encoding: "utf8" })
      .filter((f) => typeof f === "string" && f.endsWith(".ts"))
      .map((f) => join("lib", f));
    // Комментарии не в счёт: удаление гейта 2026-08-10 в них как раз описано.
    const strip = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
        .replace(/(^|[^:])\/\/[^\n]*/g, (_m, pre) => pre);
    const hits: string[] = [];
    let cycleHits = 0;
    for (const f of files) {
      const code = strip(readFileSync(f, "utf8"));
      if (code.includes("depth exceeded")) hits.push(f);
      if (code.includes("delegation cycle")) cycleHits += 1;
    }
    expect(hits).toEqual([]);
    // Контроль сканера: живой текст он находит.
    expect(cycleHits).toBeGreaterThan(0);
  });
});

describe("склейка SPLIT_TASK", () => {
  const split = (rs: string[]) =>
    `split failed: no roles accepted the task (${rs.join("; ")})`;

  test("все роли остановлены — сводка тоже отказ", () => {
    expect(
      isByDesignRefusal(
        split([
          "backend: no_available_agent: backend (all candidates stopped)",
          "design: no_available_agent: design (all candidates stopped)",
        ]),
      ),
    ).toBe(true);
  });

  test("одна роль мертва — сводка поломка", () => {
    expect(
      isByDesignRefusal(
        split([
          "backend: no_available_agent: backend (all candidates stopped)",
          "design: no_available_agent: design",
        ]),
      ),
    ).toBe(false);
  });
});

describe("таблица в шапке сверена с производителями", () => {
  /**
   * Круг 29: в таблице стояли номера строк, и все семь протухли молча. Замена —
   * счёт мест, а он обязан считаться, а не вычитываться: иначе через круг
   * соврёт ровно так же, просто другим числом.
   */
  const SRC = readFileSync(join(import.meta.dir, "..", "lib", "action-dispatch.ts"), "utf8");
  const CODE = SRC.split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

  test.each([
    ["cannot delegate to self", 2],
    ["delegation cycle", 3],
    ["delegation depth exceeded", 0],
    ["no_available_agent:", 1],
  ])("«%s» производится в %i месте(ах)", (text, want) => {
    const n = CODE.split(text as string).length - 1;
    expect(n).toBe(want as number);
  });

  test("delegate_skipped: склеивается шаблоном, а не литералом", () => {
    // Отдельным тестом, потому что grep по самому тексту даёт здесь ноль — и
    // из этого нуля легко вывести «строка мертва». Производитель один.
    expect(CODE).not.toContain("delegate_skipped");
    const n = CODE.split("`delegate_${outcome.status}: ").length - 1;
    expect(n).toBe(1);
  });

  test("все производители — в ветке DELEGATE_TO_ROLE функции dispatchAction", () => {
    // Шапка называет одно место вместо семи номеров; если тексты расползутся
    // по файлу, это утверждение станет ложным раньше, чем счёт.
    const start = CODE.indexOf('case "DELEGATE_TO_ROLE":');
    expect(start).toBeGreaterThan(-1);
    const end = CODE.indexOf('    case "', start + 10);
    const branch = CODE.slice(start, end === -1 ? undefined : end);
    for (const text of ["cannot delegate to self", "delegation cycle", "no_available_agent:"]) {
      expect(branch).toContain(text);
    }
  });
});
