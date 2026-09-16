/**
 * Аудит 2026-09-11, круг 51: четыре комментария, чьё утверждение проверялось
 * кодом и коду противоречило.
 *
 * В этом репозитории комментарий равноправен коду: по нему решают, что чинить,
 * а что не трогать. Врущий комментарий поэтому дороже отсутствующего — он
 * не молчит, а уводит. Собраны здесь те четыре, где враньё меняло решение
 * читателя, а не только его настроение:
 *
 *  • `createDiagnosticTask` (lib/diagnostic.ts) обещал идемпотентность,
 *    которой нет ни в одном боевом вызове: дедуп ключуется на `failedActionId`,
 *    а живой вызывающий берёт его из logAction — свежий UUID каждый раз.
 *    Прочитавший обещание снимет троттл `isDiagTaskThrottled` как «дублирующую
 *    защиту» и получит пятьдесят карточек на доске владельца.
 *  • Шапка lib/action-dispatch.ts говорила «для 12 action types» при 31 и
 *    обещала обход через `lib/actions.ts`, которого нет с 2026-08-12.
 *  • Комментарий к бюджету в `respondAs` (lib/handoff.ts) называл
 *    DELEGATE_TO_ROLE путём, который счётчик НЕ передаёт, — ровно наоборот:
 *    именно он его и передаёт. Пошедший «чинить» починил бы работающее.
 *  • Докблок `APPROVAL_SELECT` (lib/approvals.ts) перечислял способ расхождения
 *    «TTL отключён». Отключить TTL нечем; выдумка отправляла искать
 *    несуществующую настройку.
 *
 * Проверяется здесь не текст ради текста, а то, что утверждение и код сходятся:
 * каждый тест сначала измеряет код, потом требует, чтобы проза не спорила.
 */
import { test, expect, describe, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { ACTION_TYPES } from "../lib/permissions.ts";
import { approvalTtlMs, APPROVAL_TTL_MS } from "../lib/approvals.ts";

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}
/** Докблоки несут ` * ` в каждой строке — сплющиваем, иначе не найти фразу. */
function flat(s: string): string {
  return s.replace(/^\s*\*/gm, "").replace(/\s+/g, " ");
}

const DIAGNOSTIC = src("lib/diagnostic.ts");
const DISPATCH = src("lib/action-dispatch.ts");
const HANDOFF = src("lib/handoff.ts");
const APPROVALS = src("lib/approvals.ts");

describe("createDiagnosticTask не обещает идемпотентность, которой нет", () => {
  test("докблок называет настоящую границу потока, а не дедуп", () => {
    const at = DIAGNOSTIC.indexOf("export function createDiagnosticTask");
    const doc = flat(DIAGNOSTIC.slice(DIAGNOSTIC.lastIndexOf("/**", at), at));
    expect(doc).not.toContain("Idempotent: returns the existing-task path");
    expect(doc).toContain("isDiagTaskThrottled");
    expect(doc).toContain("crypto.randomUUID()");
  });

  test("живой вызывающий действительно передаёт свежий id, а не устойчивый", () => {
    // Это и есть причина, по которой дедуп не срабатывает: id приходит из
    // logAction. Если однажды сюда станут передавать устойчивый ключ, эта
    // строка исчезнет — и докблок придётся переписывать обратно.
    const at = DISPATCH.indexOf("createDiagnosticTask({");
    expect(at).toBeGreaterThan(0);
    const call = DISPATCH.slice(at, at + 400);
    // Ключ дедупа — id только что записанного действия аудита, а не что-то
    // устойчивое вроде типа действия или хэша ошибки. Пока это так,
    // `skippedReason:"duplicate"` в проде недостижим, и докблок обязан
    // говорить именно это.
    expect(call).toContain("failedActionId: actionId,");
    expect(DISPATCH).toContain("({ id: actionId } = closeDispatchAudit(");
  });
});

describe("шапка диспатчера не называет числа и мёртвых модулей", () => {
  const HEAD = flat(DISPATCH.slice(0, DISPATCH.indexOf("*/")));
  /** Действующая часть шапки — до разбора. Разбор цитирует неправду нарочно. */
  const ACTIVE = HEAD.slice(0, HEAD.indexOf("Аудит 2026-09-11:"));
  const POSTMORTEM = HEAD.slice(HEAD.indexOf("Аудит 2026-09-11:"));

  test("action types считает список, а не проза", () => {
    // Замер: число живёт ровно в одном месте.
    expect(ACTION_TYPES.length).toBe(31);
    // Никакого числа в действующей части — правило круга 20: убрать, а не
    // подогнать. Прежнее «12» уцелело только внутри разбора, как цитата.
    expect(ACTIVE).not.toMatch(/\d+ action types/);
    expect(POSTMORTEM).toContain("«для 12 action types»");
  });

  test("обещания обойти lib/actions.ts больше нет — модуля нет с 2026-08-12", () => {
    expect(ACTIVE).not.toContain("lib/actions.ts");
    expect(POSTMORTEM).toContain("этого модуля нет с 2026-08-12");
    expect(() => src("lib/actions.ts")).toThrow();
  });
});

describe("комментарий к бюджету handoff не путает боевой путь с легаси", () => {
  test("DELEGATE_TO_ROLE передаёт счётчик — это видно в коде", () => {
    expect(DISPATCH).toContain("budget: ctx.handoffBudget,");
  });

  test("проза в respondAs не называет его теряющим счётчик", () => {
    const at = HANDOFF.indexOf("const budget = opts.budget ??");
    expect(at).toBeGreaterThan(0);
    const note = HANDOFF.slice(HANDOFF.indexOf("// S1: жёсткий потолок"), at);
    expect(note).not.toContain("не передал (путь DELEGATE_TO_ROLE");
    expect(note).toContain("легаси-вызов по @-упоминанию");
  });
});

describe("TTL одобрений отключить нечем", () => {
  const saved = process.env.APPROVAL_TTL_HOURS;
  afterEach(() => {
    if (saved === undefined) delete process.env.APPROVAL_TTL_HOURS;
    else process.env.APPROVAL_TTL_HOURS = saved;
  });

  test("любое «выключающее» значение даёт те же сутки", () => {
    for (const v of ["0", "-1", "", "off", "false", "NaN", "  "]) {
      process.env.APPROVAL_TTL_HOURS = v;
      expect(approvalTtlMs()).toBe(APPROVAL_TTL_MS);
    }
    delete process.env.APPROVAL_TTL_HOURS;
    expect(approvalTtlMs()).toBe(APPROVAL_TTL_MS);
    // Положительное значение уважается — это настройка, а не константа.
    process.env.APPROVAL_TTL_HOURS = "48";
    expect(approvalTtlMs()).toBe(2 * APPROVAL_TTL_MS);
  });

  test("докблок APPROVAL_SELECT считает способы расхождения по правде", () => {
    const at = APPROVALS.indexOf("const APPROVAL_SELECT");
    const doc = flat(APPROVALS.slice(APPROVALS.lastIndexOf("/**", at), at));
    expect(doc).toContain("двумя способами");
    expect(doc).not.toContain("тремя способами");
    // Выдумка осталась разобранной, а не повторённой.
    expect(doc.indexOf("Третьим способом здесь значилось")).toBeLessThan(
      doc.indexOf("Отключить его нечем"),
    );
  });
});
