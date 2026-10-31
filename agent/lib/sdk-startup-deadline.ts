/** Bound CLI startup and first inference, without interrupting tool execution. */
export class SdkStartupTimeout extends Error {
  constructor() { super("Агент не получил первый ответ модели вовремя. Запрос остановлен; автоматического повтора нет."); this.name = "SdkStartupTimeout"; }
}
export function sdkStartupTimeoutMs(value = process.env.AGENT_SDK_STARTUP_TIMEOUT_MS): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 30_000 && n <= 600_000 ? n : 180_000;
}
export async function* withSdkStartupDeadline<T extends { type: string }>(
  source: AsyncIterable<T> & { close(): void }, milliseconds = sdkStartupTimeoutMs(),
): AsyncGenerator<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SdkStartupTimeout()), milliseconds);
  });
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = iterator.next();
      const item = started ? await next : await Promise.race([next, timeout]);
      if (item.done) return;
      // System/init events alone do not establish that inference is working.
      if (item.value.type === "assistant" || item.value.type === "result") {
        started = true;
        clearTimeout(timer);
      }
      yield item.value;
    }
  } finally {
    clearTimeout(timer);
    // SDK close terminates the child transport, including on timeout/budget break.
    try { source.close(); } catch { /* Preserve the original failure. */ }
  }
}
