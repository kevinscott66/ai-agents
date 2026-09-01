/**
 * Аудит 2026-08-28: все гарды рендера мерили РАЗМЕР, ни один не мерил СТОИМОСТЬ.
 *
 * Байты исходника (200 КБ), объявленная сторона и сторона растра (4096) не
 * ограничивают время `render()` никак: фильтры делают стоимость огромной при
 * крошечном документе. Замер на этой машине через настоящий renderSvgToPng,
 * каждый документ проходит ВСЕ прежние гарды:
 *
 *   1 rect с feGaussianBlur stdDeviation="400",  208 Б ->  2 213 мс
 *   2 такие же rect,                             283 Б ->  5 955 мс
 *   10 таких rect,                             1 141 Б -> 35 253 мс
 *
 * Линейно по числу примитивов: 200 КБ исходника — это часы. И это не «медленно»,
 * а «мёртво»: `new Resvg()` и `.render()` синхронны и нативны, они держат
 * event-loop, в котором живут все 12 ботов, HTTP Mini App и планировщики.
 * Внутрипроцессный таймаут тут не помогает принципиально — он не получит
 * управление. GENERATE_SVG_IMAGE апрува не требует, лимит 20/мин на агента, а
 * SVG к нему пишет модель, читающая недоверенный вход.
 *
 * Поэтому растеризация уехала в одноразовый воркер, который можно убить
 * снаружи. Проверяем и семантику (через подставной spawn — быстро), и живой
 * процесс, и главное свойство: цикл во время дорогого рендера жив.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  MAX_PNG_BYTES,
  SVG_RENDER_TIMEOUT_MS,
  _readCappedBytes,
  renderSvgToPng,
  type SvgRenderProc,
  type SvgRenderSpawn,
} from "../lib/svg-render.ts";

const SRC = readFileSync(new URL("../lib/svg-render.ts", import.meta.url), "utf-8");
const OK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>`;

function stream(bytes?: Uint8Array | null): {
  readable: ReadableStream<Uint8Array>;
  close: () => void;
} {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      // null — поток, который не отдаёт EOF, пока его не закроют снаружи.
      if (bytes === null) return;
      if (bytes !== undefined) c.enqueue(bytes);
      closed = true;
      c.close();
    },
  });
  return {
    readable,
    close: () => {
      if (closed) return;
      closed = true;
      try {
        ctrl?.close();
      } catch {
        /* уже закрыт */
      }
    },
  };
}

type Fake = { proc: SvgRenderProc; killed: string[]; payload: () => string };

/** Подставной процесс: `stall` — тот, что не отдаёт EOF, пока его не убьют. */
function fakeSpawn(opts: {
  stdout?: Uint8Array;
  stderr?: string;
  code?: number;
  stall?: boolean;
}): { spawn: SvgRenderSpawn } & Fake {
  const killed: string[] = [];
  let payload = "";
  const out = stream(opts.stall ? null : (opts.stdout ?? new Uint8Array()));
  const err = stream(new TextEncoder().encode(opts.stderr ?? ""));
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  if (!opts.stall) resolveExit(opts.code ?? 0);
  const proc: SvgRenderProc = {
    stdout: out.readable,
    stderr: err.readable,
    exited,
    kill(signal) {
      killed.push(String(signal ?? "SIGTERM"));
      out.close();
      err.close();
      resolveExit(137);
    },
  };
  return {
    proc,
    killed,
    payload: () => payload,
    spawn: (p) => {
      payload = p;
      return proc;
    },
  };
}

/** Отказ как значение: у `.catch` тип шире, чем Error, и tsc это ловит. */
async function rejection(p: Promise<unknown>): Promise<Error> {
  return p.then(
    () => {
      throw new Error("ожидался отказ, а вызов завершился успешно");
    },
    (e) => e as Error,
  );
}

describe("таймаут рендера", () => {
  test("зависший рендер убивается и даёт понятную ошибку", async () => {
    const f = fakeSpawn({ stall: true });
    await expect(renderSvgToPng(OK_SVG, { timeoutMs: 30 }, f.spawn)).rejects.toThrow(
      /не уложился в 30ms/,
    );
    expect(f.killed).toEqual(["SIGKILL"]);
  });

  test("ошибка таймаута говорит, что делать автору документа", async () => {
    const f = fakeSpawn({ stall: true });
    const e = await rejection(renderSvgToPng(OK_SVG, { timeoutMs: 30 }, f.spawn));
    expect(e.message).toContain("упрости документ");
  });

  test("потолок по умолчанию объявлен и конечен", () => {
    expect(SVG_RENDER_TIMEOUT_MS).toBe(10_000);
    expect(MAX_PNG_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("отказ воркера доезжает до вызывающего", () => {
  test("сообщение из stderr в нашем формате разворачивается", async () => {
    const f = fakeSpawn({ stderr: JSON.stringify({ error: "svg слишком большой растр: 9x9px" }), code: 3 });
    await expect(renderSvgToPng(OK_SVG, {}, f.spawn)).rejects.toThrow(/слишком большой растр/);
  });

  test("чужая длинная строка обрезается, как любая чужая", async () => {
    const f = fakeSpawn({ stderr: JSON.stringify({ error: "e".repeat(500) }), code: 3 });
    const e = await rejection(renderSvgToPng(OK_SVG, {}, f.spawn));
    expect(e.message).toContain("симв.");
    expect(e.message.length).toBeLessThan(200);
  });

  test("не наш формат отдаётся как есть", async () => {
    const f = fakeSpawn({ stderr: "panic: что-то родное", code: 101 });
    await expect(renderSvgToPng(OK_SVG, {}, f.spawn)).rejects.toThrow(/panic/);
  });

  test("молчаливый ненулевой код называет код", async () => {
    const f = fakeSpawn({ stderr: "", code: 9 });
    await expect(renderSvgToPng(OK_SVG, {}, f.spawn)).rejects.toThrow(/код 9/);
  });

  test("нулевой код с пустым растром — тоже отказ, а не пустой файл", async () => {
    const f = fakeSpawn({ stdout: new Uint8Array(), code: 0 });
    await expect(renderSvgToPng(OK_SVG, {}, f.spawn)).rejects.toThrow(/пустой растр/);
  });

  test("успешный рендер возвращает ровно байты воркера", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const f = fakeSpawn({ stdout: png, code: 0 });
    const out = await renderSvgToPng(OK_SVG, {}, f.spawn);
    expect(Buffer.from(out).equals(Buffer.from(png))).toBe(true);
  });

  test("воркеру передаются размер-потолок и решение о шрифтах", async () => {
    const f = fakeSpawn({ stdout: new Uint8Array([1]), code: 0 });
    await renderSvgToPng(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>a</text></svg>`, { width: 800 }, f.spawn);
    const sent = JSON.parse(f.payload()) as Record<string, unknown>;
    expect(sent.maxSide).toBe(4096);
    expect(sent.loadSystemFonts).toBe(true);
    expect(sent.fitToWidth).toBe(800);
  });
});

describe("дешёвые текстовые гарды остаются в родителе", () => {
  const never: SvgRenderSpawn = () => {
    throw new Error("процесс запускать было не нужно");
  };

  test("мусор отсекается ДО запуска процесса", async () => {
    const cases: [string, RegExp][] = [
      ["", /empty|пуст/i],
      [`<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(210 * 1024)}</svg>`, /too large/i],
      [`<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"/>`, /ENTITY|сущност/i],
      [
        `<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>`,
        /ссылк/i,
      ],
      [
        `<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"></svg>`,
        /слишком больш/,
      ],
    ];
    for (const [svg, re] of cases) {
      await expect(renderSvgToPng(svg, {}, never)).rejects.toThrow(re);
    }
  });
});

describe("_readCappedBytes", () => {
  test("под потолком отдаёт всё", async () => {
    const s = stream(new Uint8Array([1, 2, 3]));
    const r = await _readCappedBytes(s.readable, 10);
    expect(r.overflow).toBe(false);
    expect([...r.bytes]).toEqual([1, 2, 3]);
  });

  test("за потолком — флаг, и буфер дальше не растёт", async () => {
    const s = stream(new Uint8Array(50));
    const r = await _readCappedBytes(s.readable, 10);
    expect(r.overflow).toBe(true);
    expect(r.bytes.length).toBeLessThanOrEqual(10);
  });

  test("пустой поток — пустой буфер без переполнения", async () => {
    const s = stream(new Uint8Array());
    const r = await _readCappedBytes(s.readable, 10);
    expect(r.overflow).toBe(false);
    expect(r.bytes.length).toBe(0);
  });
});

describe("живой воркер", () => {
  test("обычный документ по-прежнему рисуется", async () => {
    const png = await renderSvgToPng(OK_SVG);
    expect([...png.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
  }, 30_000);

  test("растр, заданный только viewBox, ловится авторитетной проверкой", async () => {
    // Регекс в родителе такой размер не видит вовсе — его меряет уже
    // разобранный документ, то есть воркер. Текст сообщения прежний.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 90000 90000"><rect width="1" height="1"/></svg>`;
    await expect(renderSvgToPng(svg)).rejects.toThrow(/слишком большой растр/);
  }, 30_000);

  test("сломанный документ даёт ошибку разбора, а не падение", async () => {
    await expect(renderSvgToPng(`<svg xmlns="http://www.w3.org/2000/svg">`)).rejects.toThrow();
  }, 30_000);
});

describe("главное свойство: цикл жив во время дорогого рендера", () => {
  test("рендер-бомба убивается, а таймеры родителя всё это время тикают", async () => {
    // Документ проходит все прежние гарды: меньше килобайта, ровно 4096x4096.
    // До правки это была синхронная нативная заморозка процесса, и тиков за неё
    // было бы ноль.
    const bomb =
      `<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="4096">` +
      `<filter id="b"><feGaussianBlur stdDeviation="400"/></filter>` +
      Array.from(
        { length: 4 },
        (_, i) => `<rect x="${i}" y="0" width="4096" height="4096" filter="url(#b)" fill="#123"/>`,
      ).join("") +
      `</svg>`;

    let ticks = 0;
    const t = setInterval(() => {
      ticks += 1;
    }, 50);
    try {
      await expect(renderSvgToPng(bomb, { timeoutMs: 1200 })).rejects.toThrow(/не уложился/);
    } finally {
      clearInterval(t);
    }
    expect(ticks).toBeGreaterThanOrEqual(3);
  }, 30_000);
});

describe("применение", () => {
  test("родитель больше не конструирует Resvg сам", () => {
    const code = SRC.split("\n").filter((l) => {
      const t = l.trimStart();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    });
    expect(code.filter((l) => l.includes("new Resvg("))).toEqual([]);
    expect(code.filter((l) => l.includes('from "@resvg/resvg-js"'))).toEqual([]);
  });

  test("воркер — отдельный файл, и он же несёт конструктор", () => {
    const w = readFileSync(new URL("../lib/svg-render-worker.ts", import.meta.url), "utf-8");
    expect(w).toContain("new Resvg(");
    expect(w).toContain("rasterSizeAfterFit");
  });
});
