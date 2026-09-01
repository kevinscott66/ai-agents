/**
 * Аудит 2026-08-13: два одновременных хода одного агента жгли лимит дважды.
 *
 * На SDK-пути остаток дневного лимита снимался снимком ОДИН раз, до спавна CLI
 * (`const remainingBudget = budgetRemaining(...)`), а расход уезжал в БД тоже
 * один раз — в самом конце хода. Ходы при этом идут параллельно: telegraf
 * обрабатывает батч апдейтов через `Promise.all(updates.map(handleUpdate))`,
 * а веер по ролям в message-handler запускается без `await`. Значит оба хода
 * читали один и тот же остаток и каждый выжигал его целиком: при лимите 100k
 * в agent_token_usage ложилось ~200k, а отсечка срабатывала только на
 * следующем триггере. Перерасход масштабировался числом параллельных ходов.
 *
 * На raw-пути такого нет: checkBudget и recordUsage стоят вокруг КАЖДОГО
 * HTTP-вызова, окно рассинхрона — один запрос. usageWriter приводит SDK-путь
 * к тому же поведению: пишем нарастающим итогом по ходу дела.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { db } from "../lib/db.ts";
import {
  budgetRemaining,
  getDailyUsage,
  todayUTC,
} from "../lib/token-budget.ts";
import { usageWriter } from "../lib/agent-sdk-runtime.ts";

const AGENT = "_test_usage_writer";
const ENV_KEY = `TOKEN_BUDGET_${AGENT.toUpperCase()}`;
const ENV_BEFORE = process.env[ENV_KEY];

function used(): { input: number; output: number } {
  const u = getDailyUsage(AGENT, todayUTC());
  return { input: u.input, output: u.output };
}

afterEach(() => {
  db.prepare(`DELETE FROM agent_token_usage WHERE agent_key = ?`).run(AGENT);
  if (ENV_BEFORE === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = ENV_BEFORE;
});

describe("usageWriter пишет нарастающим итогом", () => {
  test("принимает суммы за прогон, а в БД кладёт только приращение", () => {
    const spend = usageWriter(AGENT);
    spend(100, 10);
    expect(used()).toEqual({ input: 100, output: 10 });
    // Второе assistant-сообщение: сумма выросла до 250/25.
    spend(250, 25);
    expect(used()).toEqual({ input: 250, output: 25 });
  });

  test("повторный вызов с той же суммой ничего не задваивает", () => {
    // Ровно этот случай в бою: сумма по assistant-сообщениям совпала с
    // накопительным usage у result-сообщения.
    const spend = usageWriter(AGENT);
    spend(300, 30);
    spend(300, 30);
    expect(used()).toEqual({ input: 300, output: 30 });
  });

  test("меньшая сумма не откатывает уже записанное", () => {
    // У SDK два источника (сумма по assistant и usage у result), они могут
    // разойтись. Вычесть уже записанное нельзя: recordUsage умеет только
    // прибавлять, и «отрицательное приращение» превратилось бы в ноль лишь
    // случайно, а на деле сломало бы учёт следующего вызова.
    const spend = usageWriter(AGENT);
    spend(500, 50);
    spend(200, 20);
    expect(used()).toEqual({ input: 500, output: 50 });
    // И следующий рост считается от максимума, а не от заниженного числа.
    spend(600, 60);
    expect(used()).toEqual({ input: 600, output: 60 });
  });

  test("нули не создают лишних записей", () => {
    const spend = usageWriter(AGENT);
    spend(0, 0);
    const row = db
      .prepare(`SELECT count(*) AS n FROM agent_token_usage WHERE agent_key = ?`)
      .get(AGENT) as { n: number };
    expect(row.n).toBe(0);
  });

  test("два одновременных хода видят расход друг друга", () => {
    // Суть находки. Каждый ход держит свой writer, но остаток читается из БД,
    // и приращения складываются. До правки оба хода сравнивались с одним
    // замороженным снимком в 1000 и каждый выжигал по 1000.
    process.env[ENV_KEY] = "1000";
    const a = usageWriter(AGENT);
    const b = usageWriter(AGENT);

    a(400, 0);
    // Второй ход стартовал позже и уже видит чужой расход.
    expect(budgetRemaining(AGENT)).toBe(600);
    b(400, 0);
    expect(budgetRemaining(AGENT)).toBe(200);
    a(700, 0); // ход A дошёл до 700 суммарно (+300)
    expect(budgetRemaining(AGENT)).toBe(0);
    expect(used().input).toBe(1100);
  });

  /**
   * Аудит 2026-08-21: тест «сбой записи не роняет ход» ничего не проверял.
   *
   * Он звал `usageWriter("")`, а `recordUsage` на пустом ключе выходит первой
   * же строкой (`if (!agentKey) return`, token-budget.ts:103) — до SQLite.
   * Никакого сбоя записи не происходило, `try/catch` в usageWriter не
   * исполнялся ни разу, и тест остался бы зелёным, если убрать catch целиком.
   *
   * Настоящий сбой даёт `PRAGMA query_only`: INSERT бросает «attempt to write
   * a readonly database» изнутри recordUsage. Обязательно в try/finally —
   * иначе БД останется read-only для всего остального прогона.
   */
  test("настоящий сбой записи в БД не роняет ход", () => {
    const spend = usageWriter(AGENT);

    try {
      db.exec("PRAGMA query_only = ON");
      expect(() => spend(100, 10)).not.toThrow();
    } finally {
      db.exec("PRAGMA query_only = OFF");
    }

    // Записать было нечем — счётчика в БД нет.
    expect(used()).toEqual({ input: 0, output: 0 });
  });

  test("после неудачной записи повтор досылает всё, а не приращение", () => {
    const spend = usageWriter(AGENT);

    try {
      db.exec("PRAGMA query_only = ON");
      spend(100, 10);
    } finally {
      db.exec("PRAGMA query_only = OFF");
    }

    // Ключевое: wroteInput/wroteOutput на провале НЕ двигаются, поэтому
    // следующий вызов с той же суммой видит дельту 100/10, а не 0/0. Иначе
    // токены, оплаченные до сбоя, потерялись бы навсегда.
    spend(100, 10);
    expect(used()).toEqual({ input: 100, output: 10 });
  });

  test("пустой ключ агента отсекается до БД", () => {
    // Отдельно от сбоя записи: это ранний выход recordUsage, а не catch.
    const spend = usageWriter("");
    expect(() => spend(100, 10)).not.toThrow();
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM agent_token_usage WHERE agent_key = ''`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });
});
