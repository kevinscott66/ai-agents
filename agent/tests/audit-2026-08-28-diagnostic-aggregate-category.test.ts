/**
 * Аудит 2026-08-28: класс сбоя определялся по склейке, а не по сегментам.
 *
 * `res.error` для SPLIT_TASK — это `split failed: no roles accepted the task
 * (<joinDelegationErrors>)` (action-dispatch.ts:889), для фан-аута
 * DELEGATE_TO_ROLE — сама склейка (:873). То есть строка из N сегментов
 * `role: причина`, склеенных `"; "`. А `categorizeError` — регэкспы по всей
 * строке, где порядок проверок задаёт победителя.
 *
 * Отсюда два одинаковых по корню отказа:
 *
 * 1. Один сегмент с 429 делает `rate_limited` всю сводку. `createDiagnosticTask`
 *    возвращает `deferred_rate_limited` («переживём, ретраи сами») — и
 *    настоящая поломка в соседнем сегменте не заводит НИЧЕГО. Никто её
 *    не ретраит: ретраится лимит, а не unknown action.
 * 2. Сегмент с 403 уводит сводку в `permission_denied`: задача уезжает на
 *    `perm` с уверенной гипотезой «не хватает строки в permissions» —
 *    про сбой, к правам отношения не имеющий.
 *
 * Посегментный разбор в модуле уже есть и работает верно — `isByDesignRefusal`
 * ниже требует, чтобы КАЖДЫЙ сегмент был отказом. Категоризатор просто им не
 * пользовался.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  categorizeAggregateError,
  categorizeError,
  createDiagnosticTask,
  pickResponsibleRole,
} from "../lib/diagnostic.ts";

// Дедуп в createDiagnosticTask ключуется на failedActionId; bun гоняет каталог
// одним процессом, поэтому id обязан быть свежим на каждый вызов.
const cryptoId = () => randomUUID();

const split = (...segs: string[]) =>
  `split failed: no roles accepted the task (${segs.join("; ")})`;

describe("предпосылки: посегментно эти же строки читаются иначе", () => {
  test("каждый сегмент по отдельности категоризуется верно", () => {
    expect(categorizeError("backend: 429 rate limit")).toBe("rate_limited");
    expect(categorizeError("aieng: unknown action FOO")).toBe("missing_capability");
    expect(categorizeError("qa: 403 forbidden")).toBe("permission_denied");
    expect(categorizeError("smm: ETIMEDOUT")).toBe("network");
  });

  test("склейка отдаёт победу первому сработавшему регэкспу, а не самому важному", () => {
    // Это НЕ правится и правиться не должно: у одиночной строки другого
    // способа нет. Чинится только разбор склейки.
    expect(categorizeError("backend: 429 rate limit; aieng: unknown action FOO")).toBe(
      "rate_limited",
    );
  });
});

describe("склейка разбирается по сегментам", () => {
  test("лимит у одной роли не отменяет поломку у другой", () => {
    expect(
      categorizeAggregateError(split("backend: 429 rate limit", "aieng: unknown action FOO")),
    ).toBe("missing_capability");
  });

  test("порядок сегментов ничего не решает", () => {
    expect(
      categorizeAggregateError(split("aieng: unknown action FOO", "backend: 429 rate limit")),
    ).toBe("missing_capability");
  });

  test("две настоящие поломки: побеждает самая конкретная, а не первая", () => {
    // Задача заводится одна, и выбирать приходится. Права — самая конкретная
    // и самая дешёвая в проверке причина (`/grant`), поэтому она первая в
    // CATEGORY_PRIORITY. Второй сегмент при этом не теряется: buildHypothesis
    // кладёт в задачу весь текст склейки целиком.
    expect(
      categorizeAggregateError(split("aieng: unsupported feature X", "qa: 403 forbidden")),
    ).toBe("permission_denied");
    expect(
      categorizeAggregateError(split("qa: 403 forbidden", "aieng: unsupported feature X")),
    ).toBe("permission_denied");
  });

  test("права важнее нераспознанного: диагноз конкретнее ручной сортировки", () => {
    expect(
      categorizeAggregateError(split("qa: 403 forbidden", "smm: что-то пошло не так")),
    ).toBe("permission_denied");
  });

  test("сетевой сегмент рядом с поломкой не откладывает разбор", () => {
    expect(
      categorizeAggregateError(split("smm: fetch failed", "aieng: no handler for BAR")),
    ).toBe("missing_capability");
  });

  test("нераспознанный сегмент рядом с лимитом всё-таки заводит задачу", () => {
    const c = categorizeAggregateError(
      split("backend: 429 rate limit", "smm: Tool error: сломалось"),
    );
    expect(c).toBe("unknown");
    expect(pickResponsibleRole(c)).toBe("orchestrator");
  });
});

describe("откладывать по-прежнему есть что", () => {
  test("сплошные лимиты — это лимит, задача не заводится", () => {
    const c = categorizeAggregateError(split("backend: 429", "qa: too many requests"));
    expect(c).toBe("rate_limited");
    expect(pickResponsibleRole(c)).toBeNull();
  });

  test("сплошная сеть — это сеть", () => {
    const c = categorizeAggregateError(split("backend: ECONNREFUSED", "qa: socket hang up"));
    expect(c).toBe("network");
    expect(pickResponsibleRole(c)).toBeNull();
  });

  test("лимит важнее сети, когда чинить нечего", () => {
    expect(categorizeAggregateError(split("backend: 429", "qa: ETIMEDOUT"))).toBe("rate_limited");
  });
});

describe("штатные отказы не подменяют собой поломку", () => {
  test("отказ по правилам рядом с поломкой не считается", () => {
    // `delegate_skipped:` — «не запускали», а не «сломалось». Раньше он и не
    // мешал (unknown), но теперь он обязан не мешать явно.
    expect(
      categorizeAggregateError(
        split("qa: delegate_skipped: budget", "aieng: unknown action FOO"),
      ),
    ).toBe("missing_capability");
  });

  test("сплошные отказы: категория та же, что у прежнего разбора", () => {
    // Такой набор до categorizeError вообще не доходит — его отсекает
    // shouldSkipSelfDiag. Проверяем, что поведение не выдумано.
    const s = split("qa: cannot delegate to self", "smm: delegation cycle detected");
    expect(categorizeAggregateError(s)).toBe(categorizeError(s));
  });

  test("маркер отброшенных сегментов не считается сегментом", () => {
    // `+3 further errors omitted` дописывает joinDelegationErrors; категории
    // у него нет, и он не должен превращать чистый лимит в unknown.
    expect(
      categorizeAggregateError(split("backend: 429", "+3 further errors omitted")),
    ).toBe("rate_limited");
    expect(
      categorizeAggregateError(
        split("backend: 429", "+2 further by-design refusals omitted"),
      ),
    ).toBe("rate_limited");
  });
});

describe("одиночная строка ведёт себя ровно как раньше", () => {
  for (const s of [
    "429 rate limit",
    "403 forbidden",
    "unknown action FOO",
    "ETIMEDOUT",
    "просто что-то",
    "",
  ]) {
    test(`«${s}» — категория не меняется`, () => {
      expect(categorizeAggregateError(s)).toBe(categorizeError(s));
    });
  }

  test("null и undefined — unknown, как и раньше", () => {
    expect(categorizeAggregateError(null)).toBe("unknown");
    expect(categorizeAggregateError(undefined)).toBe("unknown");
  });

  test("склейка из одного сегмента читается как одиночная строка", () => {
    const s = split("backend: 429 rate limit");
    expect(categorizeAggregateError(s)).toBe(categorizeError(s));
  });
});

describe("оба пути самодиагностики читают склейку посегментно", () => {
  test("createDiagnosticTask заводит задачу, а не откладывает по чужому лимиту", () => {
    const r = createDiagnosticTask({
      failedActionId: `agg-${cryptoId()}`,
      actionType: "SPLIT_TASK",
      error: split("backend: 429 rate limit", "aieng: unknown action FOO"),
      chatId: -828,
      originatingAgent: "orchestrator",
    });
    expect(r.category).toBe("missing_capability");
    expect(r.skippedReason).toBeUndefined();
    expect(r.task?.assigned_to).toBe("aieng");
  });

  test("сплошной лимит по-прежнему откладывается", () => {
    const r = createDiagnosticTask({
      failedActionId: `agg-${cryptoId()}`,
      actionType: "SPLIT_TASK",
      error: split("backend: 429", "qa: too many requests"),
      chatId: -828,
      originatingAgent: "orchestrator",
    });
    expect(r.category).toBe("rate_limited");
    expect(r.skippedReason).toBe("deferred_rate_limited");
    expect(r.task).toBeNull();
  });

  test("явный CREATE_DIAGNOSTIC_TASK читает ту же склейку так же", () => {
    // Ручной путь через dispatch/diagnostic-action.ts — второй источник тех же
    // решений; расходиться они не должны.
    const src = readFileSync(
      new URL("../lib/dispatch/diagnostic-action.ts", import.meta.url),
      "utf-8",
    );
    expect(src).toContain("categorizeAggregateError(failedError)");
  });
});
