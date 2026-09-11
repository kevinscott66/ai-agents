/**
 * Аудит 2026-08-28: потерянный комментарий отчитывался как разбор.
 *
 * `countReviewOutcomes` сгребала в `reviewed` все успешные исходы, кроме
 * `skipped`. Но `GithubOperationResult.action` (lib/dispatch/github.ts)
 * включает `comment_failed` и `validation_failed` — это ровно «проверка
 * отработала, но комментарий до PR не доехал». Комментарий и есть
 * ЕДИНСТВЕННЫЙ внешний след того, что PR разобран и ждёт человека: нет
 * комментария — нет и маркера, значит следующий прогон разберёт тот же PR
 * заново, и так каждые два часа.
 *
 * Дороже всего это стоило на fail-closed в agent.ts:70. Токен цикла сохранил
 * read-доступ и потерял право писать (или GitHub отвечает 403 на write):
 * `gh pr view` и `gh pr checks` проходят, `gh pr comment` — нет. На пяти PR
 * отчёт печатал «Commented: 5 · skipped: 0 · failed: 0», `nothingWorked`
 * выходил false, цикл делал exit 0 и спокойно брал следующую задачу. Ни одного
 * комментария при этом не поставлено.
 *
 * Это тот же обман, который аудит 2026-08-08 чинил внутри github.ts («соврав
 * здесь, мы оставляли risky-PR без сигнала вообще»), просто этажом выше.
 */
import { describe, expect, test } from "bun:test";
import { countReviewOutcomes, formatReviewSummary } from "../orchestrator/review-mode.ts";
import type { ReviewedPr } from "../orchestrator/review-mode.ts";
import type { GithubResult } from "../lib/dispatch/github.ts";

type Action = "merged" | "commented" | "validation_failed" | "comment_failed" | "skipped";

const ok = (action: Action): GithubResult => ({
  ok: true,
  result: { action, pr_number: 1, message: `m:${action}` },
});
const err = (): GithubResult => ({ ok: false, error: "gh: 502" });

const reviewed = (outcomes: GithubResult[]): ReviewedPr[] =>
  outcomes.map((outcome, i) => ({ pr_number: i + 1, outcome }));

/** Ровно предикат из agent.ts:70 — считаем по той же разбивке. */
const nothingWorked = (t: { reviewed: number; skipped: number; failed: number }): boolean =>
  t.failed > 0 && t.reviewed + t.skipped === 0;

describe("непоставленный комментарий — не разбор", () => {
  test("comment_failed идёт в failed, а не в reviewed", () => {
    expect(countReviewOutcomes(reviewed([ok("comment_failed")]))).toEqual({
      reviewed: 0,
      skipped: 0,
      failed: 1,
    });
  });

  test("validation_failed идёт в failed", () => {
    expect(countReviewOutcomes(reviewed([ok("validation_failed")]))).toEqual({
      reviewed: 0,
      skipped: 0,
      failed: 1,
    });
  });

  test("оба вида потери складываются с обычной ошибкой", () => {
    expect(
      countReviewOutcomes(reviewed([ok("comment_failed"), ok("validation_failed"), err()])),
    ).toEqual({ reviewed: 0, skipped: 0, failed: 3 });
  });
});

describe("fail-closed срабатывает на потере права писать", () => {
  test("пять PR без единого доехавшего комментария дают ненулевой выход", () => {
    const tally = countReviewOutcomes(
      reviewed(Array.from({ length: 5 }, () => ok("comment_failed"))),
    );
    expect(tally).toEqual({ reviewed: 0, skipped: 0, failed: 5 });
    expect(nothingWorked(tally)).toBe(true);
  });

  test("одна потеря среди доехавших цикл не валит", () => {
    // Порог намеренно «упало всё»: одиночный сломанный PR не должен заклинить
    // цикл навсегда.
    const tally = countReviewOutcomes(
      reviewed([ok("commented"), ok("comment_failed"), ok("merged")]),
    );
    expect(tally).toEqual({ reviewed: 2, skipped: 0, failed: 1 });
    expect(nothingWorked(tally)).toBe(false);
  });

  test("потеря вперемешку со skip тоже не валит", () => {
    const tally = countReviewOutcomes(reviewed([ok("skipped"), ok("comment_failed")]));
    expect(tally).toEqual({ reviewed: 0, skipped: 1, failed: 1 });
    expect(nothingWorked(tally)).toBe(false);
  });
});

describe("отчёт больше не пишет «Commented» про непоставленные комментарии", () => {
  test("разбивка и построчный список говорят одно и то же", () => {
    const out = formatReviewSummary(
      {
        scanned: 2,
        pr_numbers: [7, 8],
        results: reviewed([ok("comment_failed"), ok("validation_failed")]),
      },
      "2026-08-28T12:00:00Z",
    );
    expect(out).toContain("**Commented:** 0");
    expect(out).toContain("**failed:** 2");
    expect(out).toContain("**comment_failed**");
    expect(out).toContain("**validation_failed**");
  });
});

describe("прежняя раскладка сохранена", () => {
  test("merged и commented — это разбор, skipped — пропуск, error — провал", () => {
    expect(
      countReviewOutcomes(reviewed([ok("commented"), ok("merged"), ok("skipped"), err()])),
    ).toEqual({ reviewed: 2, skipped: 1, failed: 1 });
  });

  test("пустой прогон — нули", () => {
    expect(countReviewOutcomes([])).toEqual({ reviewed: 0, skipped: 0, failed: 0 });
  });
});
