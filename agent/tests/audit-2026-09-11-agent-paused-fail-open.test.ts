/**
 * Аудит 2026-09-11, круг 28: `isAgentPaused` глотал ЛЮБУЮ ошибку чтения в
 * «не на паузе», а обоснование этому было ссылкой на порядок вызовов.
 *
 * Соседний `isAgentDisabled` ровно эту дыру уже закрыл в круге 2026-08-04:
 * голый `catch { return false }` покрывал не только отсутствующую таблицу,
 * ради которой писался, но и SQLITE_BUSY, залоченный файл и битую страницу —
 * то есть заминка БД превращала выключенного агента в активного. Там теперь
 * глотается ровно «нет таблицы», всё остальное — «выключен».
 *
 * У `isAgentPaused` осталась старая форма, и оправдывал её докблок: «сюда
 * попадаем только после успешного чтения той же строки в isAgentDisabled, так
 * что реальный сбой БД уже привёл бы к deny выше». Сегодня это правда — оба
 * вызывающих (`agentStopReason`, `evaluateGate`) спрашивают disabled первым.
 * Но это копия правила, которую не держит ничто: безопасность одной функции
 * вынесена в порядок вызова у другой, а компилятор и тесты этот порядок не
 * стерегут. Третий вызывающий, спросивший только про паузу, получает
 * fail-open — и пауза, которую владелец поставил кнопкой, тихо исчезает
 * ровно в тот момент, когда база лежит.
 *
 * Починка — не «переписать докблок», а снять зависимость: ошибку разбираем
 * так же, как сосед. «Нет таблицы» и «нет колонки» — это схема старше фичи,
 * паузы в ней не существует, честный ответ «не на паузе». Всё прочее —
 * «на паузе»: недоступность реестра состояний не повод действовать.
 */
import { test, expect, describe } from "bun:test";
import { Database } from "bun:sqlite";
import { isAgentPaused, isAgentDisabled } from "../lib/permissions.ts";

/** Схема, в которой фича уже есть. */
function withStates(): Database {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE agent_states (
            agent_key TEXT PRIMARY KEY, status TEXT, paused INTEGER NOT NULL DEFAULT 0)`);
  d.exec(`INSERT INTO agent_states(agent_key, status, paused) VALUES ('smm','active',1)`);
  return d;
}

/** Схема старше фичи: таблица есть, колонки `paused` нет. */
function withoutPausedColumn(): Database {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE agent_states (agent_key TEXT PRIMARY KEY, status TEXT)`);
  d.exec(`INSERT INTO agent_states(agent_key, status) VALUES ('smm','active')`);
  return d;
}

/**
 * База, которая отдаёт не «нет таблицы», а сбой чтения.
 *
 * Настоящий SQLITE_BUSY в одном процессе не воспроизвести, а класс ошибки
 * важен именно НЕ схемный: вычисление колонки роняет запрос уже на строке.
 */
function readFails(): Database {
  const d = new Database(":memory:");
  d.exec(`CREATE TABLE states_real (agent_key TEXT PRIMARY KEY, status TEXT)`);
  d.exec(`INSERT INTO states_real VALUES ('smm','active')`);
  d.exec(`CREATE VIEW agent_states AS
          SELECT agent_key,
                 abs(-9223372036854775808) AS status,
                 abs(-9223372036854775808) AS paused
          FROM states_real`);
  return d;
}

describe("isAgentPaused не открывается от сбоя БД", () => {
  test("рабочая схема читается как раньше", () => {
    const d = withStates();
    expect(isAgentPaused("smm", d)).toBe(true);
    expect(isAgentPaused("dev", d)).toBe(false);
  });

  test("нет таблицы — «не на паузе», как и у соседа", () => {
    const d = new Database(":memory:");
    expect(isAgentPaused("smm", d)).toBe(false);
    expect(isAgentDisabled("smm", d)).toBe(false);
  });

  test("нет колонки — схема старше фичи, а не сбой", () => {
    const d = withoutPausedColumn();
    expect(isAgentPaused("smm", d)).toBe(false);
  });

  test("любая другая ошибка чтения — считаем агента остановленным", () => {
    const d = readFails();
    expect(() => d.prepare(`SELECT paused FROM agent_states`).get()).toThrow();
    expect(isAgentPaused("smm", d)).toBe(true);
  });

  test("сосед в той же базе тоже закрыт", () => {
    expect(isAgentDisabled("smm", readFails())).toBe(true);
  });
});
