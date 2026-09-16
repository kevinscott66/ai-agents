/**
 * Аудит 2026-09-11: две докстроки в db-maint.ts утверждали про архивацию то,
 * чего код не делает, — каждая в свою сторону.
 *
 * ПЕРВАЯ, у APPROVALS_SPEC: «отсечка та же, что у agent_actions, поэтому пара
 * „заявка + её действие“ уезжает в архив вместе, а не половинками». Общая
 * отсечка есть, но её мало: у APPROVALS_SPEC стоит `extraWhere`
 * `status <> 'pending'`, а у AGENT_ACTIONS_SPEC никакого нет. Нерешённая
 * заявка старше отсечки остаётся в живой таблице — это граница, объявленная
 * двумя абзацами ВЫШЕ в той же докстроке, — а её действие уезжает. То есть
 * текст отменял собственный соседний абзац ровно там, где тот работает.
 *
 * ВТОРАЯ, у `moveToArchive`: «`deleted > inserted` — это норма: строку могли
 * скопировать в прошлый прогон, упавший между INSERT и DELETE». Такого
 * прогона не бывает: оба стейтмента идут в одной транзакции под одним
 * предикатом, и оборвавшийся процесс откатит INSERT. Ключи тоже не
 * переиспользуются (`messages.id` — AUTOINCREMENT, у остальных источников
 * UUID). Объяснение прикрывало расхождение, которого нет, — а настоящее
 * расхождение у пары `inserted`/`selected`, потому что `INSERT OR IGNORE`
 * молчит на ЛЮБОМ нарушении ограничений архивной таблицы.
 *
 * Чинятся обе как текст: поведение здесь верное и трогать его нечем. Заявка
 * должна переживать своё действие (иначе архивация вырывала бы у владельца
 * строку из очереди), а `deleted === inserted` — то, что и требуется. Поэтому
 * сторож проверяет поведение, которое докстроки теперь описывают, и отдельно
 * — что снятые формулировки не вернулись.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../lib/db.ts";
import { getApproval } from "../lib/approvals.ts";
import { archiveOldRows } from "../lib/db-maint.ts";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const OLD = NOW - 100 * DAY;
const CHAT = -100_914;
const REQ = "req-archive-pair";

const MAINT = readFileSync(join(import.meta.dir, "..", "lib", "db-maint.ts"), "utf8");
const APPR = readFileSync(join(import.meta.dir, "..", "lib", "approvals.ts"), "utf8");

/** Только свои строки: таблицы общие с остальным прогоном. */
const ids: string[] = [];

function seedPair(status: string): { actionId: string; approvalId: string } {
  const actionId = `act-pair-${crypto.randomUUID()}`;
  const approvalId = `apr-pair-${crypto.randomUUID()}`;
  ids.push(actionId, approvalId);
  db.prepare(
    `INSERT INTO agent_actions(id, agent_key, chat_id, action_type, payload, status, created_at, request_id)
     VALUES (?, 'smm', ?, 'PUBLISH_TO_CHANNEL', '{}', 'pending_approval', ?, ?)`,
  ).run(actionId, CHAT, OLD, REQ);
  db.prepare(
    `INSERT INTO approvals(id, action_id, chat_id, requested_by, action_type, payload, status, created_at)
     VALUES (?, ?, ?, 'smm', 'PUBLISH_TO_CHANNEL', '{}', ?, ?)`,
  ).run(approvalId, actionId, CHAT, status, OLD);
  return { actionId, approvalId };
}

const has = (table: string, id: string): boolean =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE id = ?`).get(id) as { n: number }).n === 1;

const cleanup = () => {
  for (const t of [
    "agent_actions",
    "agent_actions_archive",
    "approvals",
    "approvals_archive",
  ]) {
    for (const id of ids) db.prepare(`DELETE FROM ${t} WHERE id = ?`).run(id);
  }
  ids.length = 0;
};

beforeEach(cleanup);
afterEach(cleanup);

describe("пара «заявка + действие» расходится по границе pending", () => {
  test("решённая уезжает вместе с действием", () => {
    const { actionId, approvalId } = seedPair("approved");
    archiveOldRows({ olderThanDays: 30, now: NOW });
    expect(has("agent_actions", actionId)).toBe(false);
    expect(has("agent_actions_archive", actionId)).toBe(true);
    expect(has("approvals", approvalId)).toBe(false);
    expect(has("approvals_archive", approvalId)).toBe(true);
  });

  test("нерешённая остаётся, а её действие уезжает — половинка штатна", () => {
    const { actionId, approvalId } = seedPair("pending");
    archiveOldRows({ olderThanDays: 30, now: NOW });
    // Граница `status <> 'pending'`: заявка ждёт владельца, сколько бы ей ни
    // было лет. У действия такой границы нет.
    expect(has("approvals", approvalId)).toBe(true);
    expect(has("agent_actions", actionId)).toBe(false);
    expect(has("agent_actions_archive", actionId)).toBe(true);
  });

  test("чтение половинку переживает: request_id берётся из архива", () => {
    const { approvalId } = seedPair("pending");
    archiveOldRows({ olderThanDays: 30, now: NOW });
    const a = getApproval(approvalId);
    expect(a).not.toBeNull();
    // Ради этого в APPROVAL_SELECT и стоит второй LEFT JOIN под COALESCE.
    expect(a!.request_id).toBe(REQ);
  });
});

describe("перенос не теряет и не дублирует строк", () => {
  test("сколько ушло из живой таблицы, столько пришло в архив", () => {
    const live = () =>
      (db.prepare(`SELECT COUNT(*) n FROM agent_actions`).get() as { n: number }).n;
    const arch = () =>
      (db.prepare(`SELECT COUNT(*) n FROM agent_actions_archive`).get() as { n: number }).n;

    for (let i = 0; i < 5; i++) seedPair("approved");
    const l0 = live();
    const a0 = arch();
    const res = archiveOldRows({ olderThanDays: 30, now: NOW });
    // Наблюдаемая форма контракта `deleted === inserted`: изнутри
    // moveToArchive эти числа наружу не выдаёт.
    expect(l0 - live()).toBe(arch() - a0);
    expect(res.agent_actions).toBeGreaterThanOrEqual(5);
  });

  test("повторный прогон по тем же строкам ничего не находит", () => {
    for (let i = 0; i < 3; i++) seedPair("approved");
    archiveOldRows({ olderThanDays: 30, now: NOW });
    const a0 = (db.prepare(`SELECT COUNT(*) n FROM agent_actions_archive`).get() as { n: number }).n;
    archiveOldRows({ olderThanDays: 30, now: NOW });
    expect(
      (db.prepare(`SELECT COUNT(*) n FROM agent_actions_archive`).get() as { n: number }).n,
    ).toBe(a0);
  });
});

/**
 * Обе снятые формулировки остались в файле — но как цитата внутри опровержения
 * («Аудит 2026-09-11: здесь было сказано…»), а это ровно то, чего сторож
 * добивается: история фиксируется, утверждение снято. Голое `not.toContain`
 * такие два случая не различает и потребовало бы стереть цитату, то есть
 * стереть причину правки. Поэтому проверяется не отсутствие подстроки, а то,
 * что КАЖДОЕ её вхождение стоит после маркера опровержения.
 */
function onlyQuoted(text: string, phrase: string): void {
  const marker = "Аудит 2026-09-11: здесь";
  let at = text.indexOf(phrase);
  expect(at).toBeGreaterThan(-1);
  let seen = 0;
  while (at >= 0) {
    seen++;
    expect(text.slice(Math.max(0, at - 700), at)).toContain(marker);
    at = text.indexOf(phrase, at + phrase.length);
  }
  expect(seen).toBe(1);
}

describe("снятые формулировки остались только цитатой", () => {
  test("APPROVALS_SPEC больше не обещает переезда «вместе»", () => {
    onlyQuoted(MAINT, "вместе, а не половинками");
    const spec = MAINT.slice(
      MAINT.lastIndexOf("/**", MAINT.indexOf("export const APPROVALS_SPEC")),
      MAINT.indexOf("export const APPROVALS_SPEC"),
    );
    expect(spec).toContain("extraWhere");
    expect(spec).toContain("agent_actions_archive");
  });

  test("moveToArchive больше не объясняет `deleted > inserted` упавшим прогоном", () => {
    onlyQuoted(MAINT, "упавший между INSERT и DELETE");
    const doc = MAINT.slice(
      MAINT.lastIndexOf("/**", MAINT.indexOf("function moveToArchive(")),
      MAINT.indexOf("function moveToArchive("),
    );
    expect(doc).toContain("AUTOINCREMENT");
    expect(doc).toContain("INSERT OR IGNORE");
    // Предупреждение в коде сравнивает именно deleted с selected — про это
    // докстрока теперь и говорит.
    expect(MAINT).toContain("if (res.deleted !== res.selected) {");
  });

  test("approvals.ts называет границу pending среди причин расхождения", () => {
    const doc = APPR.slice(
      APPR.lastIndexOf("/**", APPR.indexOf("const APPROVAL_SELECT")),
      APPR.indexOf("const APPROVAL_SELECT"),
    );
    expect(doc).toContain("status <> 'pending'");
    expect(doc).toContain("APPROVALS_SPEC");
  });
});
