import { useCallback, useRef, useState } from "preact/hooks";

/**
 * Состояние списка (поиск, фильтр, сортировка), живущее в query-строке.
 *
 * До этого фильтры жили только в `useState`. Отсюда три вещи, каждая из которых
 * читается как поломка:
 *
 * 1. Ссылку на отфильтрованный список нельзя было отправить: `/drops` у адресата
 *    открывался со «Все», что бы ни было на экране у отправителя.
 * 2. Обновление страницы сбрасывало выбор молча.
 * 3. Переход в карточку и «назад» возвращал на страницу раздела с фильтром
 *    «Все» — то есть человек терял место, куда долистал (WCAG-практика
 *    «предсказуемый back», Apple HIG state preservation).
 *
 * Пишем через `replaceState`, а не `pushState`: иначе каждое нажатие чипа и
 * каждая буква в поиске добавляли бы запись в историю, и «назад» стало бы
 * отменой последнего клика вместо возврата на предыдущую страницу — ровно то
 * поведение, которое HIG называет непредсказуемым.
 *
 * Значение по умолчанию из адреса вычищается: `/drops`, а не `/drops?status=all`.
 * Чужие параметры (utm-метки, реферальные хвосты) сохраняются как есть.
 *
 * Читаем и пишем через `URLSearchParams`. Она разбирает битый percent-escape
 * (`?q=%`) без исключения, в отличие от `decodeURIComponent` — тот же класс
 * падения, что чинит `url.ts`, только на этом входе.
 */
export function useQueryParam(
  key: string,
  fallback: string,
  normalize: (raw: string) => string,
): [string, (next: string) => void] {
  const [value, setValue] = useState(() =>
    normalize(readQueryParam(key) ?? fallback),
  );

  /* normalize приходит новой стрелкой на каждый рендер. Через ref — чтобы `set`
     сохранял идентичность: иначе он не годится в зависимости useEffect у
     вызывающего кода, и это ловушка на будущее, а не сегодняшняя оптимизация. */
  const normalizeRef = useRef(normalize);
  normalizeRef.current = normalize;

  const set = useCallback(
    (next: string) => {
      const clean = normalizeRef.current(next);
      setValue(clean);
      writeQueryParam(key, clean === fallback ? null : clean);
    },
    [key, fallback],
  );

  return [value, set];
}

/**
 * То же для параметра из закрытого списка значений.
 *
 * Чужое значение (`?status=<img src=x>`, опечатка, устаревшая ссылка) не
 * подставляется никуда — берётся `fallback`. Это не столько про XSS (Preact
 * экранирует текст сам), сколько про то, что неизвестный статус улетел бы в
 * запрос к API и вернул пустой список без объяснения.
 */
export function useEnumParam<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, set] = useQueryParam(key, fallback, (raw) =>
    (allowed as readonly string[]).includes(raw) ? raw : fallback,
  );
  return [value as T, set as (next: T) => void];
}

/** Ограничение длины поискового запроса — чтобы в адрес не уезжала простыня. */
export const MAX_QUERY_LEN = 100;

/** Нормализация свободного текста: без хвостовых пробелов и не длиннее лимита. */
export function normalizeQuery(raw: string): string {
  return raw.trim().slice(0, MAX_QUERY_LEN);
}

/** Значение параметра из текущего адреса; `null`, если его нет или нет окна. */
export function readQueryParam(key: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(key);
}

/** Записать параметр в адрес (`null` — удалить), не трогая остальные. */
export function writeQueryParam(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  if (value === null || value === "") params.delete(key);
  else params.set(key, value);
  const qs = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
  );
}
