/**
 * Аудит 2026-08-21: «Сводка» откатывала цифры к состоянию до события.
 *
 * Из четырёх страниц Mini App, которые перезагружаются по SSE, три уже пишут в
 * состояние через воротца последнего забега (`lib/stale.ts` — Tasks, Approvals,
 * Wiki; у «Логов» свой `createRunGate` по той же схеме). Dashboard был
 * единственным без них — и при этом самым уязвимым из всех:
 *
 *   • его загрузка — самая долгая во всём приложении. `/api/dashboard` делает
 *     ~45 синхронных запросов к SQLite в однопоточном Bun.serve, который тот же
 *     поток делит с 12 ботами;
 *   • `load()` стартует и на монтировании, и на каждом схлопнутом пакете из
 *     семи видов событий. Пересечься с собой у неё куда больше шансов, чем у
 *     страницы с ручным фильтром.
 *
 * Сценарий: открыли вкладку, монтирование ушло за данными. Пока сервер их
 * собирает, приходит `task.created` — коалесер отдаёт ведущий вызов сразу, и
 * стартует второй забег. Он видит уже новую задачу и возвращает 5. Первый
 * возвращается последним — и записывает 4, то есть картину ДО события,
 * которое перезагрузку и вызвало. На экране цифра, которой в базе уже нет, и
 * висит она до следующего события: сама себя страница не перезапросит.
 *
 * Инвариант тот же, что и у соседей: в состояние пишет только тот забег, после
 * которого не стартовал другой.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLatestRun } from "../miniapp/src/lib/stale.ts";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Dashboard.tsx"),
  "utf8",
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Модель `load()` в двух видах — со сверкой номера забега и без неё. Разница
 * между ними и есть дефект: всё остальное в модели одинаково.
 */
async function race(opts: { gated: boolean }) {
  const begin = createLatestRun();
  const state = {
    tasksPending: null as number | null,
    initialLoading: true,
    err: null as string | null,
  };

  async function load(counts: number, delayMs: number, fail?: string) {
    const isCurrent = begin();
    state.err = null;
    try {
      await sleep(delayMs);
      if (fail) throw new Error(fail);
      if (opts.gated && !isCurrent()) return;
      state.tasksPending = counts;
    } catch (e: any) {
      if (opts.gated && !isCurrent()) return;
      state.err = e.message;
    } finally {
      if (!opts.gated || isCurrent()) state.initialLoading = false;
    }
  }

  return { state, load };
}

describe("монтирование против живого события", () => {
  test("медленный ответ монтирования не перезаписывает свежие цифры", async () => {
    const { state, load } = await race({ gated: true });
    // Монтирование ушло первым и вернётся последним; SSE-забег — свежий.
    await Promise.all([load(4, 40), load(5, 5)]);
    expect(state.tasksPending).toBe(5);
  });

  test("без воротец побеждал бы именно устаревший ответ", async () => {
    // Контроль: та же модель без сверки номера — воспроизводит дефект.
    const { state, load } = await race({ gated: false });
    await Promise.all([load(4, 40), load(5, 5)]);
    expect(state.tasksPending).toBe(4);
  });

  test("порядок ответов роли не играет: свежий последним — тоже он", async () => {
    const { state, load } = await race({ gated: true });
    await Promise.all([load(4, 5), load(5, 40)]);
    expect(state.tasksPending).toBe(5);
  });

  test("пачка событий: остаётся результат последнего забега", async () => {
    const { state, load } = await race({ gated: true });
    await Promise.all([load(1, 30), load(2, 25), load(3, 20), load(9, 1)]);
    expect(state.tasksPending).toBe(9);
  });
});

describe("ошибка устаревшего забега не выносится на экран", () => {
  test("отвалившийся старый запрос не рисует ErrorBox поверх свежих данных", async () => {
    const { state, load } = await race({ gated: true });
    await Promise.all([load(0, 40, "network"), load(7, 5)]);
    expect(state.err).toBe(null);
    expect(state.tasksPending).toBe(7);
  });

  test("ошибка актуального забега показывается как раньше", async () => {
    const { state, load } = await race({ gated: true });
    await load(0, 1, "network");
    expect(state.err).toBe("network");
  });

  test("скелетон гасит только актуальный забег", async () => {
    const { state, load } = await race({ gated: true });
    await Promise.all([load(4, 40), load(5, 5)]);
    expect(state.initialLoading).toBe(false);
  });
});

describe("страница действительно ходит через воротца", () => {
  const load = SRC.slice(SRC.indexOf("  async function load()"));
  const body = load.slice(0, load.indexOf("\n  }\n") + 5);

  test("используется общий хелпер страниц, а не свой велосипед", () => {
    expect(SRC).toContain('from "../lib/stale"');
    expect(SRC).toContain("const beginLoad = useLatestRun();");
  });

  test("номер забега берётся до первого сетевого вызова", () => {
    const start = body.indexOf("const isCurrent = beginLoad();");
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(body.indexOf("await loadAggregated"));
  });

  test("обе ветки — агрегат и legacy-fallback — спрашивают воротца", () => {
    const afterAggregate = body.slice(body.indexOf("await loadAggregated"));
    expect(afterAggregate).toContain("if (!isCurrent()) return;");
    const afterFallback = body.slice(body.indexOf("await Promise.all"));
    expect(afterFallback.indexOf("if (!isCurrent()) return;")).toBeLessThan(
      afterFallback.indexOf("setTasksPending("),
    );
  });

  test("catch и finally тоже под проверкой", () => {
    expect(body).toContain("if (!isCurrent()) return;\n      setErr(");
    expect(body).toMatch(/if \(isCurrent\(\)\) setInitialLoading\(false\)/);
    expect(body).not.toMatch(/finally\s*\{\s*setInitialLoading\(false\)/);
  });

  test("вспомогательные загрузки получают тот же предикат", () => {
    // /api/health и /api/autonomy стартуют из того же load() и так же могут
    // опоздать: лампа Mac и режим автономности откатывались ровно так же.
    expect(SRC).toContain("async function loadMacHealth(isCurrent: () => boolean)");
    expect(SRC).toContain("async function loadAutonomyMode(isCurrent: () => boolean)");
    expect(SRC).not.toMatch(/loadMacHealth\(\)/);
    expect(SRC).not.toMatch(/loadAutonomyMode\(\)/);
  });

  test("агрегат при опоздании не уводит страницу в legacy-fallback", () => {
    // Пять лишних запросов, два из них — самые дорогие GET на сервере.
    const agg = SRC.slice(SRC.indexOf("async function loadAggregated"));
    const head = agg.slice(agg.indexOf("await api.dashboard"));
    expect(head).toContain("if (!isCurrent()) return true;");
    expect(head.indexOf("if (!isCurrent()) return true;")).toBeLessThan(
      head.indexOf("setTasksPending("),
    );
  });
});
