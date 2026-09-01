import { useEffect, useState, useRef } from "preact/hooks";
import { fetchDigests } from "../api";
import { usePagedList } from "../usePagedList";
import type { Digest } from "../types";
import { formatDate } from "../format";
import {
  MAX_QUERY_LEN,
  normalizeQuery,
  readQueryParam,
  writeQueryParam,
} from "../useQueryParam";
import {
  SkeletonCards,
  EmptyState,
  EmptySearch,
  ErrorState,
  ErrorMoreRow,
  SectionHead,
  SourceCountBadge,
} from "../components/states";
import { IconArrowRight, IconSearch, IconX } from "../components/icons";
import { digestsAnnouncement } from "../announce";

const PAGE = 6;
const SEARCH_DEBOUNCE_MS = 300;

/**
 * Раздел «AI-дайджесты» — полный список с поиском и подгрузкой.
 *
 * Компактный режим для главной (`limit`/`moreHref`) убран вместе с редизайном
 * (T-742): на главной теперь передовица, `home/HomeDigests.tsx`, и второй
 * режим внутри этого компонента остался бы мёртвой веткой.
 */
export function DigestsSection() {
  // Поиск: `query` — то, что в поле; `active` — то, по чему реально загружено
  // (применяется с дебаунсом). Оба стартуют из `?q=`, чтобы ссылка на результат
  // поиска открывалась результатом поиска, а не пустым списком (T-742).
  const [query, setQuery] = useState(() =>
    normalizeQuery(readQueryParam("q") ?? ""),
  );
  const [active, setActive] = useState(query);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setActive(normalizeQuery(query));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  // Адрес обновляем по `active`, а не по `query`: replaceState на каждую букву
  // — это и лишняя работа, и упор в лимит Safari на частоту вызовов history.
  useEffect(() => {
    writeQueryParam("q", active || null);
  }, [active]);

  // Смена активного запроса перезагружает список с нуля; догрузка и отмена
  // устаревших ответов — внутри хука (usePagedList → latest.ts).
  const { items, total, status, hasMore, loadMore, reload } = usePagedList<Digest>(
    (offset, signal) => fetchDigests(PAGE, offset, signal, active),
    [active],
    (d) => d.id,
  );

  const searching = active.length > 0;

  /**
   * Живая область молчит, пока человек не тронул страницу. Иначе первый же
   * переход «Загрузка…» → «Показано 6 из 6» зачитывается вслух при открытии,
   * хотя никто ничего не просил, — а исходное состояние скринридер и так
   * прочитает при обходе.
   */
  const [interacted, setInteracted] = useState(false);

  return (
    <section id="digests" class="section">
      <SectionHead
        title="AI-дайджесты"
        sub="Главное за день по крипте и AI. Без воды, со ссылками на первоисточники — проверяй сам."
      />

      <div class="search-row">
        <label class="search-field">
          <span class="search-icon" aria-hidden="true">
            <IconSearch />
          </span>
          <input
            type="search"
            class="search-input"
            placeholder="Поиск по дайджестам…"
            maxLength={MAX_QUERY_LEN}
            value={query}
            onInput={(e) => {
              setInteracted(true);
              setQuery((e.target as HTMLInputElement).value);
            }}
            aria-label="Поиск по дайджестам"
          />
          {query && (
            <button
              type="button"
              class="search-clear"
              onClick={() => {
                setInteracted(true);
                setQuery("");
              }}
              aria-label="Очистить поиск"
            >
              <IconX />
            </button>
          )}
        </label>
      </div>

      {/* Результат поиска менялся молча: карточки подменялись под курсором,
          который всё это время оставался в поле ввода, и человек, не видящий
          экран, не узнавал ни что список сменился, ни что он опустел. У ошибок
          такое объявление есть (role="alert" в ErrorState), у удачи не было.
          Что именно тут объявляется и почему — в шапке `announce.ts`. */}
      <p class="sr-only" role="status">
        {digestsAnnouncement({
          status,
          query: active,
          shown: items.length,
          total,
          hasMore,
          interacted,
        })}
      </p>

      {status === "loading" && <SkeletonCards count={3} />}

      {status === "error" && items.length === 0 && (
        <ErrorState onRetry={reload} />
      )}

      {status !== "loading" && items.length === 0 && status !== "error" && (
        searching ? (
          <EmptySearch
            query={active}
            hints={[
              "Попробуй короче: «Base» вместо «экосистема Base»",
              "Поиск идёт по заголовку и краткому содержанию, не по телу",
              "Названия проектов пишутся латиницей: Monad, Berachain",
            ]}
            onReset={() => {
              setInteracted(true);
              setQuery("");
            }}
          />
        ) : (
          <EmptyState text="Дайджестов пока нет — первый уже готовится" />
        )
      )}

      {items.length > 0 && (
        <>
          <div class="cards">
            {items.map((d) => (
              <DigestCard key={d.id} digest={d} />
            ))}
          </div>

          {status === "error" && (
            <ErrorMoreRow
              onRetry={() => {
                setInteracted(true);
                loadMore();
              }}
            />
          )}

          {hasMore && status !== "error" && (
            <div class="more-row">
              <button
                class="btn btn-ghost"
                aria-busy={status === "more"}
                onClick={() => {
                  setInteracted(true);
                  loadMore();
                }}
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

/**
 * Карточка дайджеста — настоящая ссылка, а не `div` с `onClick`.
 *
 * Было `<article role="link" tabIndex={0} onClick={route(…)}>`. Роль и
 * обработчик клавиш закрывали доступность, но `role="link"` не делает элемент
 * ссылкой ни для одной функции браузера, которая опирается на `href`:
 * cmd/ctrl-клик и клик колесом не открывали вкладку, «Открыть в новой вкладке»
 * и «Копировать адрес ссылки» в контекстном меню отсутствовали, строка
 * состояния при наведении ничего не показывала. Для ленты, которой делятся
 * ссылками, это ровно те четыре жеста, ради которых её и открывают.
 *
 * Соседний список на главной (`home/HomeDigests.tsx`) с самого начала сделан
 * через `<a href>` — здесь просто тот же приём. Клик перехватывает
 * preact-router, полная перезагрузка не происходит.
 */
function DigestCard({ digest }: { digest: Digest }) {
  return (
    <a class="card card-clickable" href={`/digest/${encodeURIComponent(digest.id)}`}>
      <div class="card-meta">
        <time>{formatDate(digest.date)}</time>
        <SourceCountBadge count={digest.sourceCount} />
      </div>
      <h2 class="card-title">{digest.title}</h2>
      <p class="card-summary">{digest.summary}</p>
      <span class="card-link">
        Читать <IconArrowRight />
      </span>
    </a>
  );
}
