import { fetchDrops } from "../api";
import type { Drop, DropStatus } from "../types";
import { usePagedList } from "../usePagedList";
import { useEnumParam } from "../useQueryParam";
import { formatDate, safeHref } from "../format";
import { dropBadgeClass, dropBadgeLabel } from "../badges";
import {
  SkeletonCards,
  EmptyState,
  ErrorState,
  ErrorMoreRow,
  SectionHead,
} from "../components/states";
import { FilterChips } from "../components/FilterChips";
import { IconExternal, IconGift } from "../components/icons";

type DropFilter = "all" | DropStatus;

const DROP_FILTERS: { value: DropFilter; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "active", label: "Идёт" },
  { value: "soon", label: "Скоро" },
  { value: "ended", label: "Закончился" },
];

const DROP_FILTER_VALUES = DROP_FILTERS.map((f) => f.value);

// Порядок «идёт → скоро → закончился» задаёт сервер (db.ts, listDrops), на
// клиенте пересортировывать нечего.
const PAGE = 9;

/**
 * Раздел «Дропы и квесты» — полный список с фильтром по статусу.
 *
 * Компактный режим для главной убран вместе с редизайном (T-742): на главной
 * теперь табло, `home/HomeDrops.tsx`.
 */
export function DropsSection() {
  // Фильтр по статусу считает сервер: на клиенте фильтровался уже загруженный
  // кусок из тридцати дропов, то есть «Закончился» показывал не завершённые
  // дропы, а те из первых тридцати, которые оказались завершёнными. Дальше
  // тридцатого дропа было не выйти вовсе — ни кнопки, ни ссылки
  // (аудит 2026-08-12).
  //
  // Живёт в `?status=`: ссылка на «Идёт» должна открываться на «Идёт», а не на
  // «Все» (T-742).
  const [filter, setFilter] = useEnumParam<DropFilter>(
    "status",
    DROP_FILTER_VALUES,
    "all",
  );

  const { items, total, status, loadedOnce, hasMore, loadMore, reload } =
    usePagedList<Drop>(
      (offset, signal) => fetchDrops(PAGE, offset, signal, filter),
      [filter],
      (d) => d.id,
    );

  // Чипы показываем, как только список загрузился ОДИН раз, и дальше не
  // прячем. Скрывать их на пустой категории нельзя — иначе из неё нечем
  // выйти; но и `status !== "loading"` не годилось: смена фильтра снова
  // ставит `loading`, полоса фильтров исчезает вместе с нажатым чипом, и
  // фокус клавиатуры улетает на `<body>` (см. `loadedOnce` в usePagedList).
  const showFilters = loadedOnce;
  const emptyEverywhere = total === 0 && filter === "all";

  return (
    <section id="drops" class="section">
      <SectionHead
        title="Дропы и квесты"
        sub="Раздачи токенов и активности, по которым ещё не поздно зайти. Статус и сроки — на виду."
      />

      {showFilters && (
        <FilterChips
          options={DROP_FILTERS}
          value={filter}
          onChange={setFilter}
          ariaLabel="Фильтр дропов по статусу"
        />
      )}

      {status === "loading" && <SkeletonCards count={3} />}
      {status === "error" && items.length === 0 && (
        <ErrorState onRetry={reload} />
      )}
      {status === "success" && items.length === 0 && emptyEverywhere && (
        <EmptyState
          icon={IconGift}
          text="Сейчас активных дропов нет. Загляни позже — добавляем по мере появления"
        />
      )}
      {status === "success" && items.length === 0 && !emptyEverywhere && (
        <EmptyState
          icon={IconGift}
          text="В этой категории сейчас пусто"
          action={{ label: "Показать все дропы", onClick: () => setFilter("all") }}
        />
      )}

      {items.length > 0 && (
        <>
          <div class="cards">
            {items.map((d) => (
              <DropCard key={d.id} drop={d} />
            ))}
          </div>

          {status === "error" && (
            <ErrorMoreRow onRetry={loadMore} />
          )}

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
        </>
      )}
    </section>
  );
}

function DropCard({ drop }: { drop: Drop }) {
  const href = safeHref(drop.url);
  return (
    <article class="card">
      <div class="card-meta">
        <h2 class="card-title card-title-inline">{drop.project}</h2>
        <span class={`badge ${dropBadgeClass(drop.status)}`}>
          {dropBadgeLabel(drop.status)}
        </span>
      </div>
      {drop.deadline && !isNaN(Date.parse(drop.deadline)) && (
        <p class="drop-deadline">
          {drop.status === "ended" ? "Закончился" : "Успеть до"} {formatDate(drop.deadline)}
        </p>
      )}
      <p class="card-summary">{drop.description}</p>
      {href && (
        <a
          class="btn btn-ghost btn-sm"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          Открыть <IconExternal />
        </a>
      )}
    </article>
  );
}
