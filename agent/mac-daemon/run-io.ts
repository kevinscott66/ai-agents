/**
 * Подача промпта дочернему `claude` на stdin — отдельным файлом, по той же
 * причине, что и `kill.ts`: `daemon.ts` при импорте читает env и лезет в сеть,
 * из теста его не поднять.
 *
 * Аудит 2026-09-11: запись в stdin была обёрнута в `try/catch`, который только
 * писал в консоль — и выполнение шло дальше как ни в чём не бывало. А дальше
 * стоит `await child.exited`. `claude --print` без промпта на stdin не выходит
 * сам: демон висел до `RUN_TIMEOUT_MS` моста, владелец получал `mac_timeout`,
 * и в этом ответе не было ни слова о настоящей причине — она осталась строкой
 * в локальном логе демона. Отказ подачи промпта — это отказ прогона, а не
 * событие для журнала.
 */

/** Минимум от `Bun.spawn`, нужный для подачи промпта. Namespace `mac-daemon`. */
export interface PromptSink {
  stdin: unknown;
}

export type FeedResult = { ok: true } | { ok: false; error: string };

/**
 * Записать промпт в stdin и закрыть его.
 *
 * Две формы — не перестраховка: `Bun.spawn` со `stdin: "pipe"` отдаёт объект с
 * `write`/`end`, а веб-стандартный путь — writer с `write`/`close`. Обе живут
 * в рантайме проекта, и подменить одну другой в тесте — единственный способ
 * проверить обе.
 *
 * Ошибку не бросаем, а возвращаем: вызывающий обязан на неё ОТВЕТИТЬ —
 * прибрать процесс и сказать мосту, — а не поймать и забыть.
 */
export async function feedPrompt(child: PromptSink, prompt: string): Promise<FeedResult> {
  try {
    const enc = new TextEncoder();
    const sink = child.stdin as {
      write?: (chunk: Uint8Array) => unknown;
      end?: () => unknown;
      close?: () => unknown;
    };
    if (typeof sink?.write === "function" && typeof sink.end === "function") {
      await sink.write(enc.encode(prompt));
      await sink.end();
    } else {
      const w = child.stdin as WritableStreamDefaultWriter<Uint8Array>;
      await w.write(enc.encode(prompt));
      await w.close();
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      error: `stdin_write_failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
