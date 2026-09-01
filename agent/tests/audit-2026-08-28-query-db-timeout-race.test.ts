/**
 * Аудит 2026-08-28: таймер отбирал уже полученный ответ.
 *
 * `spawnQueryDbWorker` читал флаг `timedOut` не там, где он что-то значит.
 * Порядок был такой:
 *
 *   const { out } = await readCapped(proc.stdout, …);  // EOF: ответ уже весь тут
 *   await proc.exited;                                 // ← уступка циклу событий
 *   const err = await errP;                            // ← и ещё одна
 *   if (timedOut) return { ok: false, error: "не уложился в 5000ms" };
 *
 * Колбэк setTimeout не вытесняет код — он ждёт своей очереди. Воркер,
 * уложившийся в 4.99с из 5, успевал дописать полный JSON, но пока мы ждали
 * его exit, срабатывал таймер, взводил флаг, и валидные строки заменялись
 * отказом. Чем ближе запрос к границе, тем чаще; повтор такого не лечит.
 *
 * Проверяем через параметр `spawn`: настоящий воркер этой гонки по заказу не
 * воспроизводит, а фейковый процесс отдаёт stdout сразу и завершается заведомо
 * позже таймаута — окно открыто детерминированно.
 */
import { describe, expect, test } from "bun:test";
import { spawnQueryDbWorker, type QueryDbProc } from "../lib/query-db.ts";

const enc = new TextEncoder();

/** Поток, который сразу отдаёт содержимое и закрывается. */
function closed(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (text) c.enqueue(enc.encode(text));
      c.close();
    },
  });
}

/** Поток, который висит, пока его не закроют снаружи (как убитый воркер). */
function openStream(): { stream: ReadableStream<Uint8Array>; close: () => void } {
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    stream,
    close: () => {
      try {
        ctrl?.close();
      } catch {
        /* уже закрыт */
      }
    },
  };
}

const ROWS = JSON.stringify({ ok: true, rows: [{ n: 1 }, { n: 2 }] });
const run = (spawn: (payload: string) => QueryDbProc, timeoutMs: number) =>
  spawnQueryDbWorker("SELECT 1", 50, { dbPath: ":memory:", timeoutMs, maxBytes: 65536 }, spawn);

describe("ответ, полученный до таймаута, остаётся ответом", () => {
  test("медленный exit после полного stdout не превращается в таймаут", async () => {
    const kills: number[] = [];
    const proc: QueryDbProc = {
      stdout: closed(ROWS),
      stderr: closed(""),
      // stdout закрыт сразу, процесс «дозавершается» заметно позже таймаута —
      // ровно то окно, в котором раньше срабатывал таймер.
      exited: new Promise((r) => setTimeout(() => r(0), 140)),
      kill: () => kills.push(1),
    };
    const res = await run(() => proc, 30);
    expect(res).toMatchObject({ ok: true, count: 2 });
    expect((res as { rows: unknown[] }).rows).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test("медленный stderr тоже не отбирает результат", async () => {
    const proc: QueryDbProc = {
      stdout: closed(ROWS),
      stderr: new ReadableStream({
        start(c) {
          setTimeout(() => c.close(), 120);
        },
      }),
      exited: Promise.resolve(0),
      kill: () => {},
    };
    expect(await run(() => proc, 30)).toMatchObject({ ok: true, count: 2 });
  });
});

describe("настоящий таймаут по-прежнему таймаут", () => {
  test("воркер, ничего не написавший, получает kill и внятную ошибку", async () => {
    const out = openStream();
    let killed = false;
    const proc: QueryDbProc = {
      stdout: out.stream,
      stderr: closed(""),
      exited: new Promise((r) => {
        const t = setInterval(() => {
          if (killed) {
            clearInterval(t);
            r(137);
          }
        }, 5);
      }),
      kill: () => {
        killed = true;
        out.close();
      },
    };
    const res = await run(() => proc, 30);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("не уложился в 30ms");
    expect(killed).toBe(true);
  });

  test("оборванный на полуслове JSON не выдаётся за результат", async () => {
    // Воркер успел начать писать, но не дописал — EOF приходит только от kill,
    // то есть уже после взвода флага. Это и есть настоящий таймаут.
    let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
    let killed = false;
    const proc: QueryDbProc = {
      stdout: new ReadableStream({
        start(c) {
          ctrl = c;
          c.enqueue(enc.encode('{"ok":true,"rows":[{"n"'));
        },
      }),
      stderr: closed(""),
      exited: new Promise((r) => setTimeout(() => r(137), 60)),
      kill: () => {
        killed = true;
        try {
          ctrl?.close();
        } catch {
          /* уже закрыт */
        }
      },
    };
    const res = await run(() => proc, 30);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("не уложился в 30ms");
    expect(killed).toBe(true);
  }, 10_000);
});

describe("колбэк таймера не роняет процесс", () => {
  test("kill, бросивший исключение, не мешает вернуть ошибку", async () => {
    const out = openStream();
    const proc: QueryDbProc = {
      stdout: out.stream,
      stderr: closed(""),
      exited: new Promise((r) => setTimeout(() => r(137), 50)),
      kill: () => {
        // Порядок как у настоящего kill: сначала последствия, потом отказ.
        out.close();
        throw new Error("процесс уже мёртв");
      },
    };
    const res = await run(() => proc, 30);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toContain("не уложился");
  });
});
