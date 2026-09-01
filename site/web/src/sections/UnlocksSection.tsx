import { useRef, useState } from "preact/hooks";
import { fetchUnlocks } from "../api";
import type { Unlock } from "../types";
import { usePagedList } from "../usePagedList";
import { useEnumParam } from "../useQueryParam";
import {
  dateMs,
  formatDate,
  formatDateTime,
  formatPct,
  formatUsd,
} from "../format";
import {
  Skeleton,
  SkeletonRows,
  EmptyState,
  ErrorState,
  ErrorMoreRow,
  SectionHead,
} from "../components/states";
import {
  IconChevronDown,
  IconChevronUp,
  IconLockOpen,
} from "../components/icons";
import { FilterChips } from "../components/FilterChips";

type UnlockRange = "all" | "7" | "30";

const RANGE_FILTERS: { value: UnlockRange; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "7", label: "7 дней" },
  { value: "30", label: "30 дней" },
];

const RANGE_VALUES = RANGE_FILTERS.map((f) => f.value);
const SORT_VALUES = ["asc", "desc"] as const;

/** Страница полного календаря. */
const PAGE = 30;

/**
 * Что рисовать в теле раздела. Отдельная чистая функция ради теста: DOM-харнесса
 * у сайта нет (см. шапку `paged-list.test.ts`), а решение здесь нетривиальное.
 *
 * Аудит 2026-08-13: вся таблица целиком лежала под `items.length > 0`, а
 * `usePagedList.load(0)` чистит список СИНХРОННО — специально, чтобы «Показать
 * ещё» не просила смещение от чужой выборки. Значит на каждую смену фильтра и
 * на каждый клик по сортировке `<thead>` размонтировался вместе с кнопкой
 * сортировки — той самой, по которой только что кликнули. Фокус улетал на
 * `body`: второй Enter подряд не делал ничего, порядок с клавиатуры туда-обратно
 * не переключался, а шапка таблицы моргала на каждом клике.
 *
 * Поэтому `reloading`: рамка и шапка остаются на месте, скелет едет внутри
 * `<tbody>`. Первую загрузку это не касается — сохранять там нечего.
 */
export type UnlocksView = "error" | "skeleton" | "reloading" | "rows" | "empty";

export function unlocksView(
  status: "loading" | "more" | "success" | "error",
  count: number,
  hadRows: boolean,
): UnlocksView {
  // Порядок именно такой. Ошибка бывает двух разных сортов, и лечатся они
  // разными кнопками: не пришла ПЕРВАЯ страница — показывать нечего, нужен
  // `ErrorState` с «загрузить заново»; не пришла ВТОРАЯ (`loadMore`) — календарь
  // на экране цел, перезагружать его не за что, нужна строка «дальше не
  // подгрузилось» под таблицей (`ErrorMoreRow`). `usePagedList` ставит `error`
  // и в том, и в другом случае, различает их только наличие строк. Без этого
  // сбой догрузки вешал большой блок ошибки НАД целой таблицей. Соседние
  // разделы (дропы, активности) устроены именно так.
  if (count > 0) return "rows";
  if (status === "error") return "error";
  if (status === "loading") return hadRows ? "reloading" : "skeleton";
  return "empty";
}

/**
 * Раздел «Разблокировки токенов» — полная таблица с сортировкой и фильтром.
 *
 * Компактный режим для главной убран вместе с редизайном (T-742): на главной
 * теперь ось времени, `home/HomeUnlocks.tsx`.
 *
 * Порядок и окно считает сервер (T-747). Раньше страница брала сто строк и
 * сортировала с фильтровала их у себя: за сотней календарь просто обрывался —
 * без кнопки, без счётчика, молча, — а «7 дней» показывали не все
 * разблокировки недели, а только те из первой сотни, что в неделю попали.
 * Клиентская сортировка через `byDate` там же и не нужна: у сервера дата
 * лежит в индексе, и NaN-компаратора, который ломал порядок всей таблицы на
 * одной неразобранной дате, больше нет как класса.
 *
 * Период и направление живут в адресе (`?range=&sort=`): без этого ссылку
 * «вот что разблокируется на неделе» отправить было нельзя — у адресата
 * открывался весь календарь (T-742).
 */
export function UnlocksSection() {
  const [sort, setSort] = useEnumParam("sort", SORT_VALUES, "asc");
  const [range, setRange] = useEnumParam<UnlockRange>(
    "range",
    RANGE_VALUES,
    "all",
  );
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const asc = sort === "asc";
  const withinDays = range === "all" ? 0 : Number(range);

  const { items, total, status, loadedOnce, hasMore, loadMore, reload } =
    usePagedList<Unlock>(
      (offset, signal) =>
        fetchUnlocks(PAGE, offset, signal, { desc: !asc, withinDays }).then(
          (r) => {
            setUpdatedAt(r.updatedAt);
            return { items: r.items, total: r.total };
          },
        ),
      [asc, withinDays],
      (u) => `${u.project}-${u.date}`,
    );

  // «Строки здесь уже были» — признак того, что шапку таблицы есть что
  // сохранять. Ref, а не состояние: перерисовка от него не нужна, он только
  // уточняет ветку в том же рендере, где список опустел.
  const hadRows = useRef(false);
  if (items.length > 0) hadRows.current = true;
  const view = unlocksView(status, items.length, hadRows.current);

  // Чипы показываем, как только список загрузился ОДИН раз, и дальше не
  // прячем. Скрывать их на пустом окне нельзя — иначе из окна нечем выйти;
  // но и `status !== "loading"` не годилось: смена периода снова ставит
  // `loading`, полоса фильтров исчезает вместе с нажатым чипом, и фокус
  // клавиатуры улетает на `<body>` (см. `loadedOnce` в usePagedList).
  const showFilters = loadedOnce;
  const emptyEverywhere = total === 0 && withinDays === 0;

  return (
    <section id="unlocks" class="section">
      <SectionHead
        title="Разблокировки токенов"
        sub="Когда в рынок выйдут залоченные токены и на какую сумму. Данные DefiLlama — чтобы давление продаж не застало врасплох."
      />

      {showFilters && (
        <FilterChips
          options={RANGE_FILTERS}
          value={range}
          onChange={setRange}
          ariaLabel="Фильтр разблокировок по периоду"
        />
      )}

      {view === "skeleton" && <SkeletonRows count={6} />}
      {view === "error" && <ErrorState onRetry={reload} />}
      {view === "empty" && (
        <EmptyState
          icon={IconLockOpen}
          text={
            emptyEverywhere
              ? "Данных по разблокировкам пока нет — подтянем со следующим обновлением"
              : "В этом окне разблокировок нет"
          }
          action={
            emptyEverywhere
              ? undefined
              : {
                  label: "Показать весь календарь",
                  onClick: () => setRange("all"),
                }
          }
        />
      )}

      {(view === "rows" || view === "reloading") && (
        <>
          <div class="table-wrap">
            {/* aria-busy — единственное, чем перезагрузка объявляется вслух:
                фокус мы теперь специально НЕ уводим, значит скринридер сам о
                смене выборки не узнает. */}
            <table class="unlocks-table" aria-busy={view === "reloading"}>
              <thead>
                <tr>
                  <th>Проект</th>
                  <th class="col-sym">Тикер</th>
                  {/* aria-sort — единственное, чем скринридер узнаёт о текущем
                      порядке: стрелка нарисована через aria-hidden. */}
                  <th aria-sort={asc ? "ascending" : "descending"}>
                    <button
                      class="th-sort"
                      onClick={() => setSort(asc ? "desc" : "asc")}
                      aria-label={
                        asc
                          ? "Сортировать по дате: сейчас от ранних к поздним"
                          : "Сортировать по дате: сейчас от поздних к ранним"
                      }
                    >
                      Дата
                      <span class="sort-arrow" aria-hidden="true">
                        {asc ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
                      </span>
                    </button>
                  </th>
                  <th class="col-num">% от выпуска</th>
                  <th class="col-num">Сумма, $</th>
                </tr>
              </thead>
              <tbody>
                {view === "reloading"
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <tr key={`sk-${i}`} aria-hidden="true">
                        <td colSpan={5}>
                          <Skeleton class="sk-line sk-row" />
                        </td>
                      </tr>
                    ))
                  : items.map((u) => (
                      <UnlockRow key={`${u.project}-${u.date}`} u={u} />
                    ))}
              </tbody>
            </table>
          </div>

          {status === "error" && <ErrorMoreRow onRetry={loadMore} />}

          {hasMore && status !== "error" && (
            <div class="more-row">
              <button
                class="btn btn-ghost"
                aria-busy={status === "more"}
                onClick={loadMore}
              >
                {status === "more" ? "Загрузка…" : "Показать ещё"}
              </button>
            </div>
          )}

          {view === "rows" && updatedAt && dateMs(updatedAt) !== null && (
            <p class="updated-note">обновлено: {formatDateTime(updatedAt)}</p>
          )}
        </>
      )}
    </section>
  );
}

function UnlockRow({ u }: { u: Unlock }) {
  return (
    <tr>
      <td class="cell-project" data-label="Проект">
        {u.project}
      </td>
      <td class="col-sym" data-label="Тикер">
        <span class="ticker">{u.symbol}</span>
      </td>
      <td data-label="Дата">{formatDate(u.date)}</td>
      <td class="col-num" data-label="% от выпуска">
        {formatPct(u.pctOfSupply)}
      </td>
      <td class="col-num" data-label="Сумма, $">
        {formatUsd(u.amountUsd)}
      </td>
    </tr>
  );
}
