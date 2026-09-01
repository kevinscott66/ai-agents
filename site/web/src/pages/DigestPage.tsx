import { fetchDigest } from "../api";
import { ApiError } from "../api";
import { useAsync } from "../useAsync";
import { formatDate, safeHref } from "../format";
import { goBackOr } from "../nav";
import {
  Skeleton,
  ErrorState,
  NotFoundState,
  SourceCountBadge,
} from "../components/states";
import { IconArrowLeft, IconExternal } from "../components/icons";
import { renderRichBlock } from "../components/RichText";

/**
 * Render the digest body as safe JSX: paragraphs split on blank lines, with
 * inline `**жирный**` and `[текст](url)` rendered via renderRichBlock. No
 * innerHTML — Preact escapes all text nodes, so this is XSS-safe by construction.
 */
function DigestBody({ body }: { body: string }) {
  const content = renderRichBlock(body);
  if (!content) return null;
  return <div class="digest-body">{content}</div>;
}

export function DigestPage({ id }: { path?: string; id?: string }) {
  const digestId = id ?? "";
  const { status, data, error, reload } = useAsync(
    (signal) => fetchDigest(digestId, signal),
    [digestId],
  );

  const goBack = () => goBackOr("/");

  const notFound = error instanceof ApiError && error.status === 404;

  return (
    <main class="container page-digest">
      <button class="btn btn-ghost btn-back" onClick={goBack}>
        <IconArrowLeft /> Назад
      </button>

      {status === "loading" && (
        <article class="digest-full">
          <Skeleton class="sk-line sk-w40" />
          <Skeleton class="sk-line sk-w80 sk-tall" />
          <Skeleton class="sk-line sk-w100" />
          <Skeleton class="sk-line sk-w100" />
          <Skeleton class="sk-line sk-w60" />
        </article>
      )}

      {status === "error" && notFound && (
        <NotFoundState
          title="Дайджест не найден"
          text="Возможно, ссылка устарела или в адресе опечатка. Свежие выпуски — в разделе «Дайджесты»."
          backHref="/digests"
          backLabel="Все дайджесты"
        />
      )}

      {status === "error" && !notFound && <ErrorState onRetry={reload} />}

      {status === "success" && data && (
        <article class="digest-full">
          <div class="card-meta">
            <time>{formatDate(data.date)}</time>
            <SourceCountBadge count={data.sourceCount} />
          </div>
          <h1 class="digest-title">{data.title}</h1>
          <p class="digest-summary">{data.summary}</p>

          {data.body && data.body.trim() !== "" && (
            <DigestBody body={data.body} />
          )}

          {data.items.length > 0 && (
            <>
              <h2 class="digest-refs-title">Источники</h2>
              <ul class="digest-items">
              {data.items.map((it, i) => {
                const href = safeHref(it.url);
                return (
                  <li key={i}>
                    {href ? (
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {it.text} <IconExternal />
                      </a>
                    ) : (
                      <span>{it.text}</span>
                    )}
                  </li>
                );
              })}
              </ul>
            </>
          )}
        </article>
      )}
    </main>
  );
}
