/**
 * Стартовый бюджет `delabs-approve-poll.service` против единственного
 * необратимого шага проекта.
 *
 * Аудит 2026-08-29 (MEDIUM 13): юнит стоял с `TimeoutStartSec=180`, а внутри
 * одного его запуска живёт публикация одобренного дайджеста в канал. SIGTERM
 * по истечении бюджета убивает процесс между отметкой `publishStartedAt` и
 * фактической отправкой — после такого обрыва каждый следующий тик отвечает
 * `publish_already_attempted`, выпуск не уходит никогда, а через 20 часов TTL
 * стирает одобренный владельцем дайджест вместе со сгоревшим ресёрчем.
 *
 * Эти проверки жили в `audit-2026-08-29-approve-poll-ingest-timeout.test.ts`
 * вперемешку с проверками таймаута ингеста. 21.09.2026 ингест убран целиком
 * (AUD-20260921-033), тот файл ушёл вместе с ним — а инварианты юнита никуда
 * не делись и переехали сюда. Слагаемое «60с на ингест» из арифметики бюджета
 * исчезло, так что запас только вырос; проверяем не конкретное число, а то,
 * ради чего его ставили.
 *
 * Здесь ничего не запускается: только чтение юнитов и исходника.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../tools/approve-poll.ts", import.meta.url),
  "utf8",
);
const UNIT = readFileSync(
  new URL("../../deploy/systemd/delabs-approve-poll.service", import.meta.url),
  "utf8",
);
const TIMER = readFileSync(
  new URL("../../deploy/systemd/delabs-approve-poll.timer", import.meta.url),
  "utf8",
);

/** Последнее вхождение директивы — так её читает и сам systemd. */
function directive(unit: string, key: string): string | undefined {
  const all = [...unit.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))];
  return all.length ? all[all.length - 1]![1]!.trim() : undefined;
}

const TIMER_PERIOD_SEC = 30 * 60;

describe("approve-poll: юнит и таймер", () => {
  test("юнит oneshot и запускает именно approve-poll.ts", () => {
    expect(directive(UNIT, "Type")).toBe("oneshot");
    expect(directive(UNIT, "ExecStart")).toContain("tools/approve-poll.ts");
  });

  test("таймер дёргает юнит раз в 30 минут", () => {
    expect(directive(TIMER, "OnUnitActiveSec")).toBe("30min");
  });

  test("прямых сетевых вызовов в approve-poll не осталось", () => {
    // Был ровно один — ингест на сайт. С его уходом весь выход в сеть у тула
    // идёт через gramjs, у которого свои таймауты и ретраи. Появившийся здесь
    // голый `fetch` снова сделал бы стартовый бюджет непредсказуемым.
    const code = SRC.split("\n").filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
    expect(code.filter((l) => /(await |= )fetch\(/.test(l))).toEqual([]);
  });
});

describe("approve-poll: стартовый бюджет покрывает необратимый шаг", () => {
  const budget = Number(directive(UNIT, "TimeoutStartSec"));

  test("TimeoutStartSec — целое число секунд", () => {
    expect(Number.isFinite(budget)).toBe(true);
    expect(Number.isInteger(budget)).toBe(true);
  });

  test("на публикацию остаётся не меньше десяти минут", () => {
    // Именно остаток и был дырой: при 180с на рендер баннера, резолв пира,
    // заливку медиа и хвост частями с ретраями приходилось 120с.
    expect(budget).toBeGreaterThanOrEqual(600);
  });

  test("бюджет заметно меньше периода таймера", () => {
    // Иначе запуски наезжают друг на друга и расписание расползается.
    expect(budget).toBeLessThan(TIMER_PERIOD_SEC);
  });

  test("юнит объясняет, из чего сложен бюджет", () => {
    expect(UNIT).toContain("TimeoutStartSec=");
    expect(UNIT).toMatch(/Арифметика \d+с/);
  });
});
