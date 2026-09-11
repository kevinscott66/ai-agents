/**
 * Аудит 2026-08-10: страница настроек показывала выдуманное состояние
 * и «сохраняла» его в никуда.
 *
 * mockSettings подставлял два захардкоженных чата («Main Chat»
 * −1001234567890, «Dev Chat»), глобальный лимит 100000 и режим "manual" —
 * ничего из этого не читалось с сервера, но подавалось админу как текущая
 * конфигурация. «Сохранить» заводило задачу `settings_update` в том же
 * выдуманном чате; ни один обработчик такого типа не читает, аппрув не
 * создавался, а тост сообщал, что создан.
 *
 * При этом рабочие ручки существуют и их же зовёт страница агентов:
 * POST /api/budgets и POST /api/autonomy без scope. Страница настроек их
 * обходила.
 *
 * Инвариант: настройка либо пишется настоящей ручкой, либо не изображается
 * редактируемой.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  budgetChanges,
  invalidBudgets,
} from "../miniapp/src/pages/Settings.tsx";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Settings.tsx"),
  "utf8",
);
const API_SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "lib", "api.ts"),
  "utf8",
);

/**
 * Код без комментариев: в шапке файла разбор бага цитирует и выдуманный
 * chat_id, и мёртвые типы задач — искать их надо в коде, а не в тексте.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/**
 * Аудит 2026-08-20: форма правит свои строки budget_settings, а не итоговый
 * лимит из `GET /api/budgets` — раньше «текущее» строилось из второго
 * (budgetMap), и лимит из окружения выглядел как свой. Здесь это просто
 * «что сейчас записано за ролью».
 */
function saved(m: Record<string, number | null>) {
  return m;
}

describe("настройки пишутся настоящими ручками", () => {
  test("сохраняются только изменившиеся лимиты", () => {
    // Отправлять весь набор — это 12 записей в budget_settings на каждое
    // нажатие «Сохранить», каждая со своим updated_by поверх чужих правок.
    const current = saved({ backend: 1000, qa: null });
    const changes = budgetChanges({ backend: 1000, qa: 500 }, current);
    expect(changes).toEqual([{ agentKey: "qa", dailyInputTokens: 500 }]);
  });

  test("снятие лимита выражается как null, а не как пропуск", () => {
    const current = saved({ backend: 1000 });
    expect(budgetChanges({ backend: null }, current)).toEqual([
      { agentKey: "backend", dailyInputTokens: null },
    ]);
  });

  test("клиент вообще умеет отправить null", () => {
    // Сервер принимает "positive number or null", а тип был `number` —
    // «убрать лимит» не выражалось на клиенте вовсе.
    const decl = API_SRC.slice(
      API_SRC.indexOf("updateBudget:"),
      API_SRC.indexOf("updateBudget:") + 300,
    );
    expect(decl).toContain("dailyInputTokens: number | null");
  });

  test("без правок на сервер не идёт ничего", () => {
    const current = saved({ backend: 1000, qa: null });
    expect(budgetChanges({ backend: 1000, qa: null }, current)).toEqual([]);
  });

  test("ноль и минус отсекаются до отправки", () => {
    // Иначе часть ключей запишется, а на нулевом прилетит 400 — форма
    // останется в состоянии «сохранено наполовину».
    expect(invalidBudgets({ backend: 0, qa: -5, smm: 100, pm: null })).toEqual([
      "backend",
      "qa",
    ]);
  });

  test("сохранение зовёт /api/budgets и /api/autonomy", () => {
    const from = SRC.indexOf("async function handleSaveSettings");
    expect(from).toBeGreaterThan(-1);
    const body = SRC.slice(from, SRC.indexOf("if (loading)", from));
    expect(body).toContain("api.updateBudget(");
    expect(body).toContain("api.setAutonomy({ mode: editingAutonomyMode })");
  });

  test("режим автономии читается с сервера, а не из константы", () => {
    expect(SRC).toContain("api.autonomy()");
    expect(SRC).toContain("defaultAutonomyMode: autonomyRes.mode");
  });
});

describe("выдуманного состояния на странице не осталось", () => {
  test("нет захардкоженного чата и мок-объекта", () => {
    expect(CODE).not.toContain("-1001234567890");
    expect(CODE).not.toContain("mockSettings");
    expect(CODE).not.toContain("Main Chat");
  });

  test("нет задач-пустышек вместо сохранения", () => {
    // Ни один обработчик в проде не читает эти типы — задача создавалась
    // и умирала на доске, а пользователю сообщали про аппрув.
    for (const t of ["settings_update", "add_chat_allowlist", "remove_chat_allowlist"]) {
      expect(CODE).not.toContain(t);
    }
    expect(CODE).not.toContain("api.createTask(");
    expect(CODE).not.toContain("создан для аппрува");
  });

  test("настройки без бэкенда не изображаются редактируемыми", () => {
    // globalTokenCap и allowlist чатов живут в env на сервере: ручки нет.
    expect(CODE).not.toContain("globalTokenCap");
    expect(CODE).not.toContain("allowedChats");
    expect(CODE).not.toContain("handleAddChat");
    expect(CODE).not.toContain("handleRemoveChat");
    // Но пользователю сказано, где они настраиваются.
    expect(CODE).toContain("TELEGRAM_ALLOWED_GROUP_IDS");
  });
});
