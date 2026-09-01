import { useEffect, useRef } from "react";

export interface Coalescer {
  /** Запросить перезагрузку. Внутри окна лишние запросы схлопываются в один. */
  schedule(run: () => void): void;
  /** Снять отложенный запуск (размонтирование страницы). */
  cancel(): void;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type SetTimer = (run: () => void, delayMs: number) => TimerHandle;
type ClearTimer = (timer: TimerHandle) => void;

/**
 * Схлопывание всплесков перезагрузки.
 *
 * Аудит 2026-08-11. Страницы Mini App вешают `load()` прямо на SSE-события, по
 * одному вызову на событие. Dashboard подписан на семь имён, включая
 * `action.executed`, — а один ход команды это десятки действий подряд от 12
 * агентов. Каждое такое событие уходило в `/api/dashboard`, где ~45
 * синхронных запросов к SQLite (agent_states, 12×бюджет, 10 задач, аппрувы, 20
 * действий). Всплеск в 15 действий = ~700 запросов к базе, и всё это на том же
 * единственном потоке `Bun.serve`, на котором живут SQLite и все 12 ботов. То
 * есть открытая вкладка со сводкой тормозила саму команду, которую показывает,
 * а GET'ы при этом ходят в общее ведро рейт-лимита — вкладка выбивала 429 сама
 * себе.
 *
 * Окно с ведущим и хвостовым вызовом, а не простой debounce: при непрерывном
 * потоке событий (а он и есть непрерывный, пока команда работает) чистый
 * debounce откладывал бы обновление бесконечно. Здесь первый вызов уходит
 * сразу, дальше — не чаще одного за окно, и последнее событие всплеска всегда
 * заканчивается перезагрузкой.
 */
export function createCoalescer(
  windowMs: number,
  now: () => number = () => Date.now(),
  setTimer: SetTimer = setTimeout,
  clearTimer: ClearTimer = clearTimeout,
): Coalescer {
  let lastRunAt = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;

  return {
    schedule(run: () => void) {
      // Окно уже открыто — просто обновляем, что запускать в конце.
      if (timer) {
        pending = run;
        return;
      }
      const wait = lastRunAt + windowMs - now();
      if (wait <= 0) {
        lastRunAt = now();
        run();
        return;
      }
      pending = run;
      timer = setTimer(() => {
        timer = null;
        const fn = pending;
        pending = null;
        lastRunAt = now();
        fn?.();
      }, wait);
    },
    cancel() {
      if (timer) clearTimer(timer);
      timer = null;
      pending = null;
    },
  };
}

/** Значение по умолчанию: всплеск действий одного хода команды укладывается сюда. */
export const SSE_COALESCE_MS = 700;

/**
 * Хук-обёртка. Один коалесер на время жизни страницы, отложенный запуск
 * снимается при размонтировании — иначе `load()` дёрнется уже у снятого
 * компонента.
 */
export function useCoalescer(windowMs: number = SSE_COALESCE_MS): Coalescer {
  const ref = useRef<Coalescer | null>(null);
  if (ref.current === null) ref.current = createCoalescer(windowMs);
  const c = ref.current;
  useEffect(() => () => c.cancel(), []);
  return c;
}
