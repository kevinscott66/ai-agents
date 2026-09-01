import { fetchActivities } from "../api";
import type { ActivityCard as ActivityCardData } from "../types";
import { usePagedList } from "../usePagedList";
import {
  SkeletonCards,
  EmptyState,
  ErrorState,
  ErrorMoreRow,
  SectionHead,
} from "../components/states";
import { IconArrowRight, IconSparkles } from "../components/icons";
import { activityBadgeClass } from "../badges";

const PAGE = 9;

/**
 * Раздел «Активности» — полный список гайдов с подгрузкой страницами.
 *
 * Компактный режим для главной убран вместе с редизайном (T-742): на главной
 * теперь лента, `home/HomeActivities.tsx`.
 *
 * Страницами по PAGE: раньше здесь было «до 50 одним запросом», и всё, что
 * дальше пятидесятого гайда, со страницы было недостижимо — ни кнопки, ни
 * ссылки (аудит 2026-08-12).
 */
export function ActivitiesSection() {
  const { items, status, hasMore, loadMore, reload } = usePagedList<ActivityCardData>(
    (offset, signal) => fetchActivities(PAGE, offset, signal),
    [],
    (a) => a.id,
  );

  return (
    <section id="activities" class="section">
      <SectionHead
        title="Активности — гайды по дропам"
        sub="Пошаговые гайды «как поучаствовать»: что за проект, что делать и какие награды ловить."
      />

      {status === "loading" && <SkeletonCards count={3} />}
      {status === "error" && items.length === 0 && (
        <ErrorState onRetry={reload} />
      )}
      {status === "success" && items.length === 0 && (
        <EmptyState
          icon={IconSparkles}
          text="Гайдов пока нет. Заглядывай позже — добавляем по мере появления дропов"
        />
      )}

      {items.length > 0 && (
        <>
          <div class="cards">
            {items.map((a) => (
              <ActivityCard key={a.id} activity={a} />
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

function ActivityCard({ activity }: { activity: ActivityCardData }) {
  const href = `/activity/${encodeURIComponent(activity.id)}`;
  return (
    <article class="card activity-card">
      <div class="card-meta activity-card-head">
        <h2 class="card-title card-title-inline">
          <span class="activity-emoji" aria-hidden="true">
            {activity.emoji}
          </span>{" "}
          {activity.project}
        </h2>
        <span class="badge-row">
          {activity.rewardType && (
            <span class="badge badge-reward">{activity.rewardType}</span>
          )}
          {activity.status && (
            <span class={`badge ${activityBadgeClass(activity.status)}`}>
              {activity.status}
            </span>
          )}
        </span>
      </div>
      <p class="activity-card-title">{activity.title}</p>
      {activity.intro && <p class="card-summary">{activity.intro}</p>}
      <a class="btn btn-ghost btn-sm" href={href}>
        Подробнее <IconArrowRight />
      </a>
    </article>
  );
}
