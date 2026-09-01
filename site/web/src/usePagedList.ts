import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { createLatest, type Latest } from "./latest";

export type PagedStatus = "loading" | "more" | "success" | "error";

export interface PagedList<T> {
  items: T[];
  total: number;
  status: PagedStatus;
  /**
   * Первая страница когда-либо приходила успешно. Один раз `true` — навсегда
   * `true`, в том числе на время следующих перезагрузок.
   *
   * Нужен ровно для того, что переживает смену фильтра. Разделы вешали чипы
   * на `status !== "loading"`, а `load(0)` ставит `loading` и обнуляет
   * `items`/`total` СИНХРОННО — то есть при каждом клике по чипу вся полоса
   * фильтров исчезала и появлялась заново. Мышью это моргание, клавиатурой —
   * потеря фокуса: нажатый чип пропадает из документа, фокус уезжает на
   * `<body>`, и до следующего чипа надо снова таббать с начала страницы.
   * Никакое существующее значение подставить нельзя — обнуляются оба.
   */
  loadedOnce: boolean;
  /** Есть ли что грузить дальше. */
  hasMore: boolean;
  /** Догрузить следующую страницу. */
  loadMore(): void;
  /** Повторить с начала (кнопка «Попробовать ещё раз»). */
  reload(): void;
}

export interface Page<T> {
  items: T[];
  total: number;
}

/**
 * Список с догрузкой «Показать ещё».
 *
 * `useAsync` для этого не годится: он держит один результат и перезапрашивает
 * всё заново, а страницы надо склеивать. Своя копия этой логики была только у
 * дайджестов — активности брали 50 штук одним запросом, дропы 30, и всё, что
 * дальше, было недостижимо: ни кнопки, ни ссылки. Фильтр статусов у дропов
 * при этом фильтровал загруженный кусок, то есть «Закончился» показывал не
 * завершённые дропы, а те из первых тридцати, что оказались завершёнными.
 *
 * Отмена — через `latest.ts`: страницу запускает не только эффект, но и
 * кнопки, поэтому отменять надо снаружи эффекта и обязательно с проверкой
 * поколения (замер гонки — в шапке latest.ts).
 *
 * `deps` работают как у `useAsync`: сменились — список загружается с нуля.
 *
 * `keyOf` — необязательный ключ элемента. Пагинация здесь по `offset`, а не по
 * курсору: если между запросом первой и второй страницы в начало списка
 * приедет новая запись (а она приезжает — ингест пишет дайджесты в любой
 * момент), всё сдвинется на одну позицию, и последний элемент первой страницы
 * придёт во второй ещё раз. Preact на дублирующемся `key` ругается в консоль и
 * начинает путать состояние соседних узлов. С `keyOf` повтор просто
 * отбрасывается при склейке.
 */
export function usePagedList<T>(
  fetchPage: (offset: number, signal: AbortSignal) => Promise<Page<T>>,
  deps: unknown[] = [],
  keyOf?: (item: T) => string,
): PagedList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState<PagedStatus>("loading");
  const [nonce, setNonce] = useState(0);
  // Сколько строк сервер уже отдал. Это НЕ длина списка: `keyOf` выбрасывает
  // из склейки повторы, и раньше смещение считалось от `items.length` — то
  // есть ровно на ту же величину, на которую дедуп его укоротил. Стоило
  // ингесту вставить запись в начало ленты между двумя страницами, и вторая
  // страница приходила со сдвигом, один элемент отбрасывался, смещение не
  // росло, и следующий клик просил тот же кусок снова. Кнопка «Показать ещё»
  // при этом оставалась на месте: `items.length < total` выполнялось всегда.
  // Наружу — кнопка, которая нажимается и не делает ничего, навсегда.
  const [fetched, setFetched] = useState(0);
  // Сервер отдал пустую страницу при непустом `total` — единственный признак,
  // что дальше ничего нет (total считается отдельным запросом и может успеть
  // разъехаться с выдачей). Без этого дозагрузка крутилась бы вхолостую.
  const [exhausted, setExhausted] = useState(false);
  // См. `loadedOnce` в PagedList: НЕ сбрасывается в load(0), в этом весь смысл.
  const [loadedOnce, setLoadedOnce] = useState(false);

  const fnRef = useRef(fetchPage);
  fnRef.current = fetchPage;
  const keyRef = useRef(keyOf);
  keyRef.current = keyOf;
  const fetchedRef = useRef(0);
  fetchedRef.current = fetched;
  // Статус нужен и вне рендера — в `loadMore`, чтобы не запускать вторую
  // страницу поверх ещё не пришедшей первой.
  const statusRef = useRef<PagedStatus>(status);
  statusRef.current = status;

  const latestRef = useRef<Latest>();
  if (!latestRef.current) latestRef.current = createLatest();

  const load = useCallback((offset: number) => {
    const { signal, isCurrent } = latestRef.current!.start();
    if (offset === 0) {
      // Сбрасываем СРАЗУ, а не по приходу ответа. Иначе между сменой фильтра и
      // ответом на экране остаётся прежняя выдача вместе со старым `total` —
      // то есть кнопка «Показать ещё» активна и, если по ней кликнуть, просит
      // `offset` от чужого списка и отменяет ещё не пришедшую первую страницу.
      // `fetchedRef` правим здесь же: `loadMore` читает его синхронно, до того
      // как Preact дорисует.
      setItems([]);
      setTotal(0);
      setFetched(0);
      fetchedRef.current = 0;
      setExhausted(false);
    }
    statusRef.current = offset === 0 ? "loading" : "more";
    setStatus(statusRef.current);
    fnRef
      .current(offset, signal)
      .then((res) => {
        if (!isCurrent()) return;
        setItems((prev) => {
          if (offset === 0) return res.items;
          const key = keyRef.current;
          if (!key) return [...prev, ...res.items];
          const seen = new Set(prev.map(key));
          return [...prev, ...res.items.filter((x) => !seen.has(key(x)))];
        });
        fetchedRef.current = offset + res.items.length;
        setFetched(fetchedRef.current);
        setExhausted(res.items.length === 0);
        setTotal(res.total);
        setLoadedOnce(true);
        setStatus("success");
      })
      .catch((e: Error) => {
        if (!isCurrent() || e.name === "AbortError") return;
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    load(0);
    return () => latestRef.current!.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return {
    items,
    total,
    status,
    loadedOnce,
    // Смещение и условие показа кнопки считаются РАЗНЫМИ величинами, и это не
    // небрежность. Смещение — курсор по строкам сервера (`fetched`): считать
    // его от `items.length` нельзя, потому что дедуп укорачивает список ровно
    // на ту величину, на которую сдвинулась лента, и следующий клик просит тот
    // же кусок снова — кнопка нажимается и не делает ничего, навсегда.
    //
    // А вот показывать кнопку по `fetched < total` тоже нельзя: когда ингест
    // вставил запись в начало между страницами, вторая страница приносит
    // повтор, `fetched` доезжает до `total`, а на экране на одну запись
    // меньше — кнопка исчезает, и верхняя новая запись не грузится никогда.
    // Аудит воспроизвёл: «Показано дайджестов: 7 из 8» и никакой кнопки.
    //
    // Поэтому: курсор — по строкам сервера, кнопка — по показанному.
    // `exhausted` (сервер отдал пустую страницу) закрывает случай, когда
    // `total` разъехался с выдачей и разница не выбирается никогда.
    hasMore: !exhausted && items.length < total,
    loadMore: useCallback(() => {
      // Повторный клик, пока страница в полёте, отменял бы её же запрос и
      // просил тот же `offset` заново.
      //
      // Защита живёт ЗДЕСЬ, а не в `disabled` на кнопке, и это осознанно.
      // `disabled` на кнопке, которая в этот момент в фокусе, выкидывает её из
      // порядка обхода: фокус уезжает на `<body>`, и чтобы нажать «Показать
      // ещё» второй раз, с клавиатуры надо таббать с начала страницы — на
      // каждой странице ленты. Разделы теперь ставят `aria-busy` (скринридер
      // объявляет занятость, фокус остаётся), а лишний клик глушится этой
      // строкой.
      if (statusRef.current === "loading" || statusRef.current === "more") return;
      load(fetchedRef.current);
    }, [load]),
    reload: useCallback(() => setNonce((n) => n + 1), []),
  };
}
