import { fetchActivity, ApiError } from "../api";
import type { Activity } from "../types";
import { useAsync } from "../useAsync";
import { safeHref } from "../format";
import { goBackOr } from "../nav";
import { Skeleton, ErrorState, NotFoundState } from "../components/states";
import { IconArrowLeft, IconExternal } from "../components/icons";
import { renderRichInline, renderRichBlock } from "../components/RichText";

export function ActivityPage({ id }: { path?: string; id?: string }) {
  const activityId = id ?? "";
  const { status, data, error, reload } = useAsync(
    (signal) => fetchActivity(activityId, signal),
    [activityId],
  );

  const goBack = () => goBackOr("/activities");

  const notFound = error instanceof ApiError && error.status === 404;

  return (
    <main class="container page-activity">
      <button class="btn btn-ghost btn-back" onClick={goBack}>
        <IconArrowLeft /> Назад
      </button>

      {status === "loading" && (
        <article class="activity-full">
          <Skeleton class="sk-line sk-w40" />
          <Skeleton class="sk-line sk-w80 sk-tall" />
          <Skeleton class="sk-line sk-w100" />
          <Skeleton class="sk-line sk-w100" />
          <Skeleton class="sk-line sk-w60" />
        </article>
      )}

      {status === "error" && notFound && (
        <NotFoundState
          title="Гайд не найден"
          text="Возможно, ссылка устарела или в адресе опечатка. Остальные гайды — в разделе «Активности»."
          backHref="/activities"
          backLabel="Все активности"
        />
      )}

      {status === "error" && !notFound && <ErrorState onRetry={reload} />}

      {status === "success" && data && (
        <article class="activity-full">
          <header class="activity-head">
            <div class="activity-project">
              {data.emoji && (
                <span class="activity-emoji-lg" aria-hidden="true">
                  {data.emoji}
                </span>
              )}
              <span class="activity-project-name">{data.project}</span>
              {data.rewardType && (
                <span class="badge badge-reward">{data.rewardType}</span>
              )}
            </div>
            <h1 class="activity-title">{data.title}</h1>
          </header>

          {data.intro && (
            <div class="activity-intro">{renderRichBlock(data.intro)}</div>
          )}

          {data.whatIs && (
            <section class="activity-block">
              <h2 class="activity-block-title">Что такое {data.project}</h2>
              <div class="activity-whatis">{renderRichBlock(data.whatIs)}</div>
            </section>
          )}

          {data.steps.length > 0 && (
            <section class="activity-block">
              <h2 class="activity-block-title">Что делаем</h2>
              <ol class="activity-steps">
                {data.steps.map((s, i) => (
                  <li key={i}>{renderRichInline(s)}</li>
                ))}
              </ol>
            </section>
          )}

          <ActivityDetails activity={data} />

          {data.hashtags.length > 0 && (
            <div class="activity-hashtags">
              {data.hashtags.map((h, i) => (
                <span class="hashtag" key={i}>
                  #{h}
                </span>
              ))}
            </div>
          )}

          {safeHref(data.url) && (
            <a
              class="btn btn-primary activity-cta"
              href={safeHref(data.url)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Открыть проект <IconExternal />
            </a>
          )}
        </article>
      )}
    </main>
  );
}

/**
 * Детали гайда — таблица «ключ → значение», а не семь одинаковых плиток с
 * эмодзи. Эмодзи здесь были декорацией: 💰 рядом со словом «Собрано» ничего не
 * добавляет, а скринридер читает их как «мешок с деньгами». Пустые поля больше
 * не рисуем прочерком: у половины гайдов заполнены два-три поля из семи, и
 * страница на треть состояла из «—».
 */
function ActivityDetails({ activity }: { activity: Activity }) {
  const rows: { label: string; value: string }[] = [
    { label: "Собрано", value: activity.raised },
    { label: "Фонды и инвесторы", value: activity.investors },
    { label: "Траты", value: activity.spent },
    { label: "Время", value: activity.time },
    { label: "Тип награды", value: activity.rewardType },
    { label: "Статус", value: activity.status },
    { label: "Дата получения", value: activity.dateReceive },
  ].filter((r) => r.value && r.value.trim() !== "");

  if (rows.length === 0) return null;

  return (
    <section class="activity-block">
      <h2 class="activity-block-title">Детали</h2>
      <dl class="specs specs-kv">
        {rows.map((r) => (
          <div class="spec" key={r.label}>
            <dt class="spec-k">{r.label}</dt>
            <dd class="spec-v">{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
