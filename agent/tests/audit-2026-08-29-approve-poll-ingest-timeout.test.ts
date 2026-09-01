/**
 * Аудит 2026-08-29 (MEDIUM 13). Юнит `delabs-approve-poll.service` стоял с
 * `TimeoutStartSec=180`, а внутри одного его запуска живёт ЕДИНСТВЕННЫЙ
 * необратимый шаг всего проекта: публикация одобренного дайджеста в @delabsru.
 *
 * Что ломалось. Шаг 1 (ингест статей на сайт) ходил в сеть голым
 * `await fetch(url, …)` без `AbortSignal`. Зависший сайт — не отдающий ни
 * ответа, ни RST — держал этот await столько, сколько позволит ядро, то есть
 * съедал весь стартовый бюджет юнита целиком. Дальше systemd слал SIGTERM.
 * Если он приходил ПОСЛЕ строки `pending.publishStartedAt = …` и
 * `deps.savePending(pending)`, но до того, как `send` дошёл до канала, отметка
 * оставалась на диске навсегда: каждый следующий тик отвечал
 * `publish_already_attempted` и не публиковал ничего, а через 20 часов
 * (`MAX_AGE_MS`) TTL стирал pending со словами «Черновик утрачен, повторить
 * нечем» и `process.exit(1)`. Одобренный владельцем выпуск и оплаченный ресёрч
 * пропадали от того, что чужой сайт не ответил.
 *
 * Что чинит правка:
 *  1. `ingestArticle` получил `AbortSignal` с бюджетом `SITE_INGEST_TIMEOUT_MS`
 *     (дефолт 15с) — ровно как давно сделано в `lib/site-ingest.ts`. Худший
 *     ингест теперь ограничен сверху: 4 статьи (`articlesFromResearch` режет
 *     `.slice(0, 4)`) × 15с = 60с, а не «сколько продержится сокет».
 *  2. `TimeoutStartSec` поднят так, чтобы после этих ограниченных 60с
 *     оставался большой запас на необратимую часть (баннер, резолв пира,
 *     заливка медиа, хвост частями с ретраями) — и при этом остался заметно
 *     меньше периода таймера (30 минут), чтобы расписание не расползалось.
 *
 * Живой прогон `tools/approve-poll.ts` публикует в канал и ингестит на
 * delabs.space — здесь не запускается ничего: только экспортированные функции
 * с подменённым `fetch`, инжектируемый шов `PublishDeps` и чтение юнитов.
 */
import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import {
  ingestArticle,
  _resolveIngestTimeoutMs,
  runApprovedPublish,
  type PublishDeps,
} from "../tools/approve-poll.ts";
import type { PendingDraft, DraftArticle } from "../tools/daily-draft.ts";

const SRC = readFileSync(new URL("../tools/approve-poll.ts", import.meta.url), "utf8");
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

function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}
const CODE = codeLines(SRC);

/** `articlesFromResearch` в daily-draft.ts режет список на `.slice(0, 4)`. */
const ARTICLES_CAP = 4;

function article(title: string): DraftArticle {
  return {
    title,
    date: "2026-08-29",
    summary: "s",
    body: "b",
    items: [],
    sourceCount: 0,
  } as DraftArticle;
}

const ENV_KEYS = ["SITE_INGEST_URL", "SITE_INGEST_TOKEN", "SITE_INGEST_TIMEOUT_MS"] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.SITE_INGEST_URL = "https://example.invalid/api/internal/digests";
  process.env.SITE_INGEST_TOKEN = "t";
  delete process.env.SITE_INGEST_TIMEOUT_MS;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

describe("approve-poll: предпосылки — что успевает случиться внутри одного запуска", () => {
  test("юнит oneshot и запускает именно approve-poll.ts", () => {
    expect(directive(UNIT, "Type")).toBe("oneshot");
    expect(directive(UNIT, "ExecStart")).toContain("tools/approve-poll.ts");
  });

  test("таймер дёргает юнит раз в 30 минут", () => {
    expect(directive(TIMER, "OnUnitActiveSec")).toBe("30min");
  });

  test("сетевой вызов в approve-poll ровно один — ингест", () => {
    const calls = CODE.filter((l) => l.includes("await fetch(") || l.includes("= fetch("));
    expect(calls.length).toBe(1);
  });
});

describe("approve-poll: ингест не может съесть весь стартовый бюджет", () => {
  test("зависший сайт обрывается по таймауту, а не держит запуск", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      ((_u: any, init: any) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(new DOMException("The operation was aborted.", "AbortError")),
          );
        })) as any,
    );
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const got = await Promise.race([
        ingestArticle(article("зависший сайт"), { _timeoutMs: 40 }),
        new Promise((r) => setTimeout(() => r("pending"), 2000)),
      ]);
      expect(got).toBeNull();
    } finally {
      errSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("запрос действительно отменяется — сигнал доезжает до fetch", async () => {
    const seen: { signal?: AbortSignal } = {};
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      ((_u: any, init: any) =>
        new Promise((_res, rej) => {
          seen.signal = init?.signal;
          init?.signal?.addEventListener("abort", () =>
            rej(new DOMException("The operation was aborted.", "AbortError")),
          );
        })) as any,
    );
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await ingestArticle(article("отмена"), { _timeoutMs: 40 });
      expect(seen.signal).toBeInstanceOf(AbortSignal);
      expect(seen.signal!.aborted).toBe(true);
    } finally {
      errSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("таймаут отличим в логе от сетевой ошибки", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      ((_u: any, init: any) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(new DOMException("The operation was aborted.", "AbortError")),
          );
        })) as any,
    );
    const seen: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...a: any[]) =>
      seen.push(a.map(String).join(" ")),
    );
    try {
      await ingestArticle(article("таймаут"), { _timeoutMs: 40 });
      expect(seen.some((l) => l.includes("таймаут") && l.includes("40"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });

  test("успешный ответ по-прежнему отдаёт id, таймер не мешает", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response(JSON.stringify({ id: "slug-1" }), { status: 200 })) as any,
    );
    try {
      expect(await ingestArticle(article("ок"))).toBe("slug-1");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("не-ok ответ по-прежнему даёт null", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
      (async () => new Response("nope", { status: 500 })) as any,
    );
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await ingestArticle(article("500"))).toBeNull();
    } finally {
      errSpy.mockRestore();
      fetchSpy.mockRestore();
    }
  });
});

describe("approve-poll: SITE_INGEST_TIMEOUT_MS читается по правилам EnvironmentFile", () => {
  // `EnvironmentFile=` отдаёт для строки `KEY=` пустую строку, а не undefined —
  // поэтому `??` тут был бы неверным оператором.
  test("пустая строка — это «не задано», а не «ноль»", () => {
    expect(_resolveIngestTimeoutMs("")).toBe(_resolveIngestTimeoutMs(undefined));
  });

  test("строка из пробелов тоже даёт дефолт", () => {
    expect(_resolveIngestTimeoutMs("   ")).toBe(_resolveIngestTimeoutMs(undefined));
  });

  test("мусор, ноль и отрицательное значение уходят в дефолт", () => {
    const def = _resolveIngestTimeoutMs(undefined);
    expect(_resolveIngestTimeoutMs("abc")).toBe(def);
    expect(_resolveIngestTimeoutMs("0")).toBe(def);
    expect(_resolveIngestTimeoutMs("-5")).toBe(def);
  });

  test("нормальное значение уважается", () => {
    expect(_resolveIngestTimeoutMs("2500")).toBe(2500);
  });

  test("дефолт положительный и в разумных секундах", () => {
    const def = _resolveIngestTimeoutMs(undefined);
    expect(def).toBeGreaterThanOrEqual(5000);
    expect(def).toBeLessThanOrEqual(60_000);
  });
});

describe("approve-poll: стартовый бюджет юнита покрывает необратимый шаг", () => {
  const budget = Number(directive(UNIT, "TimeoutStartSec"));
  const worstIngestSec = (ARTICLES_CAP * _resolveIngestTimeoutMs(undefined)) / 1000;

  test("TimeoutStartSec — целое число секунд", () => {
    expect(Number.isFinite(budget)).toBe(true);
    expect(Number.isInteger(budget)).toBe(true);
  });

  test("после худшего ингеста остаётся ≥10 минут на публикацию", () => {
    // Именно этот остаток и был дырой: 180 − 60 = 120с на рендер баннера,
    // резолв пира, заливку медиа и хвост частями. SIGTERM в этом окне =
    // потерянный выпуск.
    expect(budget - worstIngestSec).toBeGreaterThanOrEqual(600);
  });

  test("бюджет заметно меньше периода таймера в 30 минут", () => {
    expect(budget).toBeLessThan(1800);
  });

  test("юнит объясняет, из чего сложен бюджет", () => {
    expect(UNIT).toContain("SITE_INGEST_TIMEOUT_MS");
  });
});

describe("approve-poll: отметка публикации ставится строго после ингеста", () => {
  test("провал ингеста не оставляет ни отметки, ни отправки", async () => {
    const pending: PendingDraft = {
      createdAt: new Date().toISOString(),
      previewMsgId: 1,
      dayTitle: "Дайджест",
      articles: [article("а"), article("б")],
    } as PendingDraft;

    const saved: PendingDraft[] = [];
    let sends = 0;
    const deps: PublishDeps = {
      ingest: async () => null,
      renderBanner: async () => new Uint8Array([1]),
      send: async () => {
        sends += 1;
        return { msgId: 1, tailSent: 0, tailTotal: 0 } as any;
      },
      savePending: (p) => {
        saved.push(JSON.parse(JSON.stringify(p)));
      },
      clearPending: () => {},
      log: () => {},
    };

    const out = await runApprovedPublish(pending, deps);
    expect(out.published).toBe(false);
    expect(out.reason).toBe("ingest_failed");
    expect(sends).toBe(0);
    expect(pending.publishStartedAt).toBeUndefined();
    expect(saved.some((p) => p.publishStartedAt)).toBe(false);
  });
});
