/**
 * Аудит 2026-08-29: разбор рендера SVG, HTTP-хелпера и мелкой обвязки.
 *
 * Что здесь закрепляется:
 *  1. `WORKER_PATH` в svg-render.ts и query-db.ts строится через
 *     `fileURLToPath`, а не через `URL.pathname`. `.pathname` отдаёт путь в
 *     ПРОЦЕНТНОЙ кодировке, и установка в каталоге с пробелом (`ai%20agents`)
 *     ломала не один документ, а всю фичу: `Bun.spawn` получал несуществующий
 *     файл. Гард — по всему дереву, потому что дефект уже был найден и починен
 *     в cover-banner.ts, а в двух соседях остался.
 *  2. `renderSvgToPng` убивает воркер и тогда, когда чтение stdout упало.
 *     Раньше kill звался только из колбэка таймера и из ветки overflow, а
 *     `finally` таймер снимал безусловно — исключение из чтения оставляло
 *     живой процесс без сторожа.
 *  3. `clipForError` режет по символам, а не по единицам UTF-16: строка едет в
 *     `agent_actions.error`, а одиночный суррогат в SQLite превращается в
 *     ДРУГОЙ символ.
 *  4. `extractSvg` перебирает не больше 16 холостых кандидатов `<svg`. Раньше
 *     цикл был квадратичным по длине текста модели (200 КБ — 8 секунд
 *     синхронно, на том же потоке, где 12 ботов и HTTP Mini App).
 *  5. `fetchJson` на пустом теле (204/205) говорит про пустое тело, а не про
 *     «invalid JSON».
 *  6. `getTriggerStats` на сбое БД отдаёт нули, а не бросает: у всех остальных
 *     функций модуля политика «сбой БД глотаем» уже была.
 *  7. `launchWithRestart` при 429 ждёт столько, сколько назвал Telegram, даже
 *     если это больше `maxDelayMs` — поведение не менялось, но докблок опции
 *     обещал обратное, и пин нужен, чтобы обещание не разъехалось снова.
 */
import { describe, expect, test, spyOn } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { db } from "../lib/db.ts";
import { clipForError, renderSvgToPng } from "../lib/svg-render.ts";
import type { SvgRenderProc } from "../lib/svg-render.ts";
import { extractSvg } from "../lib/svg-fallback.ts";
import { fetchJson } from "../lib/http.ts";
import { getTriggerStats } from "../lib/trigger-anti-dup.ts";
import { launchWithRestart } from "../lib/launch-restart.ts";

const AGENT_ROOT = join(import.meta.dir, "..");

/** Комментарии снимаем построчно: блочный `[\s\S]*?` съел бы код между двумя. */
function stripComments(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split("\n")) {
    let line = raw;
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close === -1) {
        out.push("");
        continue;
      }
      line = line.slice(close + 2);
      inBlock = false;
    }
    for (;;) {
      const open = line.indexOf("/*");
      if (open === -1) break;
      const close = line.indexOf("*/", open + 2);
      if (close === -1) {
        line = line.slice(0, open);
        inBlock = true;
        break;
      }
      line = line.slice(0, open) + line.slice(close + 2);
    }
    const lineComment = line.indexOf("//");
    if (lineComment !== -1) line = line.slice(0, lineComment);
    out.push(line);
  }
  return out;
}

function tsFilesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) found.push(p);
    }
  };
  walk(dir);
  return found;
}

describe("audit-2026-08-29 / путь воркера не в процентной кодировке", () => {
  test("никто не берёт .pathname у URL, построенного от import.meta.url", () => {
    const offenders: string[] = [];
    for (const file of [
      ...tsFilesUnder(join(AGENT_ROOT, "lib")),
      ...tsFilesUnder(join(AGENT_ROOT, "orchestrator")),
      ...tsFilesUnder(join(AGENT_ROOT, "tools")),
    ]) {
      const lines = stripComments(readFileSync(file, "utf8"));
      const src = lines.join("\n");
      let at = src.indexOf(".pathname");
      while (at !== -1) {
        const back = src.slice(Math.max(0, at - 200), at);
        if (back.includes("import.meta.url")) {
          const lineNo = src.slice(0, at).split("\n").length;
          offenders.push(`${file.slice(AGENT_ROOT.length + 1)}:${lineNo}`);
        }
        at = src.indexOf(".pathname", at + 1);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("оба воркера объявлены через fileURLToPath", () => {
    for (const rel of ["lib/svg-render.ts", "lib/query-db.ts"]) {
      const src = readFileSync(join(AGENT_ROOT, rel), "utf8");
      expect(src).toContain("const WORKER_PATH = fileURLToPath(");
    }
  });
});

const VALID_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>`;

function closedStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.close();
    },
  });
}

describe("audit-2026-08-29 / воркер рендера не остаётся без сторожа", () => {
  test("падение чтения stdout всё равно убивает процесс", async () => {
    let killed = 0;
    const proc: SvgRenderProc = {
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.error(new Error("stdout оборвался"));
        },
      }),
      stderr: closedStream(),
      // Воркер жив: без kill этот промис не разрешится никогда — ровно то
      // состояние, в котором он молотит документ «часами» (см. шапку модуля).
      exited: new Promise<number>(() => {}),
      kill: () => {
        killed += 1;
      },
    };

    await expect(renderSvgToPng(VALID_SVG, {}, () => proc)).rejects.toThrow();
    expect(killed).toBe(1);
  });

  test("на нормальном пути лишнего вреда нет — kill идёт по уже мёртвому", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    let killed = 0;
    const proc: SvgRenderProc = {
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(png));
          c.close();
        },
      }),
      stderr: closedStream(),
      exited: Promise.resolve(0),
      kill: () => {
        killed += 1;
      },
    };

    const out = await renderSvgToPng(VALID_SVG, {}, () => proc);
    expect(Buffer.from(out).equals(png)).toBe(true);
    expect(killed).toBe(1);
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("audit-2026-08-29 / clipForError не рвёт суррогатные пары", () => {
  test("эмодзи ровно на границе не превращается в половинку", () => {
    const out = clipForError("x".repeat(119) + "😀" + "y".repeat(50));
    expect(LONE_SURROGATE.test(out)).toBe(false);
    expect(out.startsWith("x".repeat(119) + "😀")).toBe(true);
  });

  test("символ вне BMP тоже целый", () => {
    const out = clipForError("q".repeat(119) + "\u{20000}" + "z".repeat(30));
    expect(LONE_SURROGATE.test(out)).toBe(false);
  });

  test("ASCII-поведение не поменялось", () => {
    const exact = "x".repeat(120);
    expect(clipForError(exact)).toBe(exact);
    expect(clipForError("короткая")).toBe("короткая");
    expect(clipForError("x".repeat(150_018))).toContain("+149898 симв.");
  });
});

describe("audit-2026-08-29 / extractSvg не квадратичен", () => {
  test("нормальный ответ модели по-прежнему разбирается", () => {
    expect(extractSvg(`вот картинка:\n${VALID_SVG}\nготово`)).toBe(VALID_SVG);
  });

  test("несколько холостых кандидатов перед настоящим — всё ещё находим", () => {
    expect(extractSvg("<svg>".repeat(3) + VALID_SVG)).toBe(VALID_SVG);
  });

  test("после потолка холостых кандидатов сдаёмся, а не сканируем дальше", () => {
    // Цена ограничения, названная честно: документ ПОСЛЕ двадцати незакрытых
    // `<svg` мы уже не найдём. Такой текст — не ответ модели с картинкой, а
    // мусор; альтернатива ему — секунды синхронного скана на общем потоке.
    expect(extractSvg("<svg>".repeat(20) + VALID_SVG)).toBeNull();
  });

  test("длинный мусор без единого закрытия отдаёт null", () => {
    expect(extractSvg("<svg ".repeat(4000))).toBeNull();
  });
});

describe("audit-2026-08-29 / fetchJson про пустое тело говорит прямо", () => {
  test("204 — это не «invalid JSON»", async () => {
    const spy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    try {
      await expect(
        fetchJson("https://api.example.test/x", { label: "github" }),
      ).rejects.toThrow(/github empty body \(HTTP 204\)/);
    } finally {
      spy.mockRestore();
    }
  });

  test("настоящий сломанный JSON по-прежнему называется своим именем", async () => {
    const spy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{нет", { status: 200 }),
    );
    try {
      await expect(
        fetchJson("https://api.example.test/x", { label: "figma" }),
      ).rejects.toThrow(/figma invalid JSON/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("audit-2026-08-29 / getTriggerStats не роняет вызывающего", () => {
  test("сбой БД — нули и запись в лог, а не исключение", () => {
    const orig = db.prepare;
    (db as unknown as { prepare: unknown }).prepare = function (sql: string) {
      if (/processed_triggers/i.test(sql)) throw new Error("БД недоступна");
      return (orig as (s: string) => unknown).call(db, sql);
    };
    try {
      const stats = getTriggerStats();
      expect(stats.inWindow).toBe(0);
      expect(stats.total).toBe(0);
      expect(stats.windowSeconds).toBeGreaterThan(0);
    } finally {
      (db as unknown as { prepare: unknown }).prepare = orig;
    }
  });

  test("здоровая БД считает как считала", () => {
    const stats = getTriggerStats();
    expect(Number.isInteger(stats.inWindow)).toBe(true);
    expect(Number.isInteger(stats.total)).toBe(true);
    expect(stats.total).toBeGreaterThanOrEqual(stats.inWindow);
  });
});

describe("audit-2026-08-29 / maxDelayMs не отменяет retry_after", () => {
  test("названные Telegram 120 секунд важнее нашего потолка в 10", async () => {
    const slept: number[] = [];
    const err = Object.assign(new Error("429: Too Many Requests"), {
      code: 429,
      parameters: { retry_after: 120 },
    });
    await launchWithRestart(
      { def: { key: "qa" }, bot: { launch: () => Promise.reject(err) } },
      {
        maxDelayMs: 10_000,
        maxRestarts: 1,
        sleep: async (ms: number) => {
          slept.push(ms);
        },
        now: () => 0,
      },
    );
    expect(slept).toEqual([120_000]);
  });

  test("без retry_after потолок вызывающего соблюдается", async () => {
    const slept: number[] = [];
    await launchWithRestart(
      { def: { key: "qa" }, bot: { launch: () => Promise.reject(new Error("boom")) } },
      {
        delayMs: 3_000,
        maxDelayMs: 10_000,
        maxRestarts: 6,
        sleep: async (ms: number) => {
          slept.push(ms);
        },
        now: () => 0,
      },
    );
    expect(Math.max(...slept)).toBeLessThanOrEqual(10_000);
  });
});
