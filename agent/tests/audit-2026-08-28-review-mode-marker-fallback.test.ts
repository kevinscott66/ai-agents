/**
 * Аудит 2026-08-28: фолбэк-маркер не совпадал ни с одним публикуемым комментарием.
 *
 * Когда `gh pr view` не вернул `headRefOid`, сверяться с head не с чем, и код
 * «падал на старый безусловный маркер» `<!-- ai-agents-control-review -->`.
 * Только текущий `controlReviewMarker()` всегда пишет
 * `<!-- ai-agents-control-review sha=… -->`, где старая строка НЕ является
 * подстрокой: после `review` идёт ` sha=`, а не ` -->`. Все четыре тела
 * комментария в lib/dispatch/github.ts используют только `controlReviewMarker`.
 *
 * Значит фолбэк-ветка могла вернуть только `false` — код не делал того, что
 * обещал его собственный комментарий. Прогон 1 ставил комментарий с
 * `sha=unknown`; прогон 2 через два часа его не находил и комментировал снова.
 * Вместо идемпотентности — бесконечный спам одинаковыми комментариями на
 * неизменившемся head плюс лишний `gh pr checks` на каждый прогон.
 *
 * Существующий t513-review-mode.test.ts:245 эту ветку «покрывал», подкладывая
 * в тело `CONTROL_REVIEW_MARKER` — строку, которую прод больше нигде не пишет.
 * Зелёный тест на недостижимых данных и сломанная ветка сосуществовали.
 */
import { describe, expect, it } from "bun:test";
import { runReviewMode } from "../orchestrator/review-mode.ts";
import { CONTROL_REVIEW_MARKER, controlReviewMarker } from "../lib/dispatch/github.ts";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const now = () => NOW;
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const OPEN_SAFE_PR = JSON.stringify({
  state: "OPEN",
  mergeable: "MERGEABLE",
  files: [{ path: "docs/readme.md" }],
});

function runner(opts: {
  commentBodies: string[];
  headSha: string;
  calls: string[][];
}) {
  return async (args: string[]) => {
    opts.calls.push(args);
    if (args[1] === "list") {
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { number: 401, headRefName: "agent/no-head-oid", updatedAt: minsAgo(2) },
        ]),
        stderr: "",
      };
    }
    if (args.some((a) => a.startsWith("comments"))) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          comments: opts.commentBodies.map((body) => ({ body })),
          // Пустая строка — ровно то, что видит код при ответе gh без headRefOid.
          headRefOid: opts.headSha,
        }),
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: OPEN_SAFE_PR, stderr: "" };
  };
}

const wasReviewed = (calls: string[][]) => calls.some((c) => c[1] === "checks");

describe("gh не вернул headRefOid", () => {
  it("комментарий с sha=unknown узнаётся и PR не разбирается заново", async () => {
    // Именно это прод и пишет, когда head неизвестен, — и именно этого фолбэк
    // не находил, комментируя PR на каждом прогоне.
    const calls: string[][] = [];
    const runGh = runner({
      calls,
      headSha: "",
      commentBodies: [`${controlReviewMarker("")}\n✅ **Validation Passed**`],
    });

    const result = await runReviewMode({ runGh, now });
    expect(result.results[0]!.outcome).toMatchObject({
      ok: true,
      result: { action: "skipped" },
    });
    expect(wasReviewed(calls)).toBe(false);
  });

  it("комментарий с настоящим sha тоже узнаётся: сверять не с чем", async () => {
    const calls: string[][] = [];
    const runGh = runner({
      calls,
      headSha: "",
      commentBodies: [
        `${controlReviewMarker("1111111111111111111111111111111111111111")}\n🚫 **Validation Failed**`,
      ],
    });

    await runReviewMode({ runGh, now });
    expect(wasReviewed(calls)).toBe(false);
  });

  it("старый безусловный маркер по-прежнему узнаётся", async () => {
    const calls: string[][] = [];
    const runGh = runner({
      calls,
      headSha: "",
      commentBodies: [`${CONTROL_REVIEW_MARKER}\nlegacy review`],
    });

    await runReviewMode({ runGh, now });
    expect(wasReviewed(calls)).toBe(false);
  });

  it("чужие комментарии маркером не считаются — PR разбирается", async () => {
    const calls: string[][] = [];
    const runGh = runner({
      calls,
      headSha: "",
      commentBodies: ["LGTM", "<!-- some-other-bot -->"],
    });

    await runReviewMode({ runGh, now });
    expect(wasReviewed(calls)).toBe(true);
  });

  it("комментариев нет вовсе — PR разбирается", async () => {
    const calls: string[][] = [];
    const runGh = runner({ calls, headSha: "", commentBodies: [] });

    await runReviewMode({ runGh, now });
    expect(wasReviewed(calls)).toBe(true);
  });
});

describe("привязка к head сохранена", () => {
  it("тот же head — не разбираем", async () => {
    const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const calls: string[][] = [];
    const runGh = runner({
      calls,
      headSha: sha,
      commentBodies: [`${controlReviewMarker(sha)}\nold review`],
    });

    await runReviewMode({ runGh, now });
    expect(wasReviewed(calls)).toBe(false);
  });

  it("новый push — разбираем снова", async () => {
    const calls: string[][] = [];
    const runGh = runner({
      calls,
      headSha: "1111111111111111111111111111111111111111",
      commentBodies: [
        `${controlReviewMarker("0000000000000000000000000000000000000000")}\n🚫 **Validation Failed**`,
      ],
    });

    await runReviewMode({ runGh, now });
    expect(wasReviewed(calls)).toBe(true);
  });
});
