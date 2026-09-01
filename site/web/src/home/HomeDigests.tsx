import { fetchDigests } from "../api";
import { useAsync } from "../useAsync";
import type { Digest } from "../types";
import { formatDate, plural } from "../format";
import { EmptyState, ErrorState, Skeleton } from "../components/states";
import { IconArrowRight } from "../components/icons";
import { HomeHead } from "./HomeHead";

const COUNT = 4;

/**
 * Дайджесты на главной — передовица, а не сетка карточек: первый разворачивается
 * крупно, остальные идут пронумерованным списком. Это то, как устроена первая
 * полоса издания, и это единственный блок главной, где текст важнее данных.
 */
export function HomeDigests() {
  const { status, data, reload } = useAsync((signal) =>
    fetchDigests(COUNT, 0, signal),
  );
  const items = data?.items ?? [];
  const [lead, ...rest] = items;

  return (
    <section id="digests" class="section">
      <HomeHead
        title="Свежие дайджесты"
        sub="Главное за день по крипте и AI. Без воды, со ссылками на первоисточники — проверяй сам."
        href="/digests"
        linkLabel="Все дайджесты"
      />

      {status === "loading" && <LeadSkeleton />}
      {status === "error" && <ErrorState onRetry={reload} />}
      {status === "success" && items.length === 0 && (
        <EmptyState text="Дайджестов пока нет — первый уже готовится" />
      )}

      {lead && (
        <>
          <LeadCard digest={lead} />
          {rest.length > 0 && (
            <ol class="dlist">
              {rest.map((d, i) => (
                <li key={d.id}>
                  <a class="dlist-row" href={`/digest/${encodeURIComponent(d.id)}`}>
                    <span class="dlist-n" aria-hidden="true">
                      {String(i + 2).padStart(2, "0")}
                    </span>
                    <span class="dlist-body">
                      <span class="dlist-title">{d.title}</span>
                      <span class="dlist-meta">
                        {formatDate(d.date)} · {d.sourceCount}{" "}
                        {plural(d.sourceCount, "источник", "источника", "источников")}
                      </span>
                    </span>
                    <IconArrowRight />
                  </a>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function LeadCard({ digest }: { digest: Digest }) {
  return (
    <a class="lead" href={`/digest/${encodeURIComponent(digest.id)}`}>
      <div class="lead-rail">
        <time class="lead-date" dateTime={digest.date}>
          {formatDate(digest.date)}
        </time>
        <span class="lead-sources">
          {digest.sourceCount}{" "}
          {plural(digest.sourceCount, "источник", "источника", "источников")}
        </span>
      </div>
      <div class="lead-body">
        <h3 class="lead-title">{digest.title}</h3>
        <p class="lead-summary">{digest.summary}</p>
        <span class="card-link">
          Читать <IconArrowRight />
        </span>
      </div>
    </a>
  );
}

/** Скелет повторяет форму передовицы + двух строк — чтобы вёрстка не прыгала. */
function LeadSkeleton() {
  return (
    <div aria-hidden="true">
      <div class="lead lead-skeleton">
        <div class="lead-rail">
          <Skeleton class="sk-line sk-w80" />
        </div>
        <div class="lead-body">
          <Skeleton class="sk-line sk-tall sk-w80" />
          <Skeleton class="sk-line sk-w100" />
          <Skeleton class="sk-line sk-w60" />
        </div>
      </div>
      <div class="dlist">
        <Skeleton class="sk-line sk-row" />
        <Skeleton class="sk-line sk-row" />
      </div>
    </div>
  );
}
