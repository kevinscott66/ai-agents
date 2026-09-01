import { useEffect, useRef, useState } from "react";

export interface Debouncer {
  /** Отложить запуск. Каждый новый вызов внутри окна отменяет предыдущий. */
  schedule(run: () => void): void;
  /** Снять отложенный запуск (размонтирование, возврат к прежнему значению). */
  cancel(): void;
}

/**
 * Хвостовой debounce: запуск ровно один, и только когда поток вызовов замер.
 *
 * Аудит 2026-08-21. На вкладке «Логи» поле «фильтр по типу» — свободный ввод,
 * `onChange` пишет каждую букву в состояние, а эффект перезагрузки объявлен как
 * `[agent, status, type]`. То есть на каждое нажатие: `setItems([])` (список
 * мигает пустым), `load(true)` — запрос в `/api/actions`, и отписка с повторной
 * подпиской на SSE `action.executed`. Слово «SEND_MESSAGE» — двенадцать букв,
 * значит двенадцать запросов вместо одного, одиннадцать из которых спрашивают
 * заведомо бессмысленный префикс («S», «SE», «SEN»). Ведро GET-лимита —
 * capacity 120 при refill 4/с, то есть одна правка фильтра съедает десятую его
 * часть и восстанавливается три секунды; исправил опечатку — ещё столько же.
 *
 * Почему не `createCoalescer`: у коалесера есть ведущий вызов, он уходит сразу.
 * Для всплеска СОБЫТИЙ это правильно (первое событие надо показать немедленно,
 * а поток не должен откладывать обновление бесконечно), но для набора текста —
 * нет: ведущий вызов это и есть запрос по одной первой букве. Здесь нужен
 * ровно противоположный край окна, поэтому отдельный примитив, а не параметр
 * к существующему.
 */
export function createDebouncer(delayMs: number): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: (() => void) | null = null;

  return {
    schedule(run: () => void) {
      pending = run;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const fn = pending;
        pending = null;
        fn?.();
      }, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

/**
 * Пауза, после которой ввод считается законченным. 350 мс — вдвое больше
 * типичного межбуквенного интервала беглого набора (~150 мс), но ниже порога,
 * на котором задержка читается как «подвисло».
 */
export const INPUT_DEBOUNCE_MS = 350;

/**
 * Значение, отстающее от `value` на паузу в наборе. Ставится в зависимости
 * эффекта вместо сырого значения поля.
 *
 * Возврат к уже применённому значению (набрал лишнюю букву и стёр её) снимает
 * отложенный запуск: перезагружать не на что.
 *
 * `delayMs` читается один раз, при создании — менять его на лету незачем, а
 * пересоздание дебаунсера потеряло бы отложенный запуск.
 */
export function useDebouncedValue<T>(
  value: T,
  delayMs: number = INPUT_DEBOUNCE_MS,
): T {
  const [settled, setSettled] = useState(value);
  const ref = useRef<Debouncer | null>(null);
  if (ref.current === null) ref.current = createDebouncer(delayMs);
  const deb = ref.current;

  useEffect(() => {
    if (value === settled) {
      deb.cancel();
      return;
    }
    deb.schedule(() => setSettled(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => () => deb.cancel(), []);
  return settled;
}
