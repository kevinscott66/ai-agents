import { fetchActivities } from "../api";
import { useAsync } from "../useAsync";
import type { ActivityCard } from "../types";
import { activityBadgeClass } from "../badges";
import { EmptyState, ErrorState, Skeleton } from "../components/states";
import { IconArrowRight, IconSparkles } from "../components/icons";
import { HomeHead } from "./HomeHead";

const COUNT = 3;

/**
 * Гайды — единственный блок главной, где карточка уместна: у каждого есть
 * обложка (эмодзи проекта) и обещание результата. Но лежат они лентой со
 * снапом, а не сеткой: три гайда сеткой — это та же «сетка карточек», что и
 * везде, а лента читается как полка и на телефоне листается пальцем.
 */
export function HomeActivities() {
  const { status, data, reload } = useAsync((signal) =>
    fetchActivities(COUNT, 0, signal),
  );
  const items = data?.items ?? [];

  return (
    <section id="activities" class="section">
      <HomeHead
        title="Гайды по активностям"
        sub="Пошагово: что за проект, что делать и какие награды ловить."
        href="/activities"
        linkLabel="Все гайды"
      />

      {status === "loading" && (
        <div class="rail" aria-hidden="true">
          {Array.from({ length: COUNT }).map((_, i) => (
            <div class="guide guide-skeleton" key={i}>
              <Skeleton class="sk-line sk-tall sk-w40" />
              <Skeleton class="sk-line sk-w80" />
              <Skeleton class="sk-line sk-w100" />
            </div>
          ))}
        </div>
      )}
      {status === "error" && <ErrorState onRetry={reload} />}
      {status === "success" && items.length === 0 && (
        <EmptyState
          icon={IconSparkles}
          text="Гайдов пока нет. Заглядывай позже — добавляем по мере появления дропов"
        />
      )}

      {items.length > 0 && (
        <div class="rail">
          {items.map((a) => (
            <GuideTile key={a.id} activity={a} />
          ))}
          <a class="guide guide-all" href="/activities">
            <span class="guide-all-text">Все гайды</span>
            <IconArrowRight size={20} />
          </a>
        </div>
      )}
    </section>
  );
}

function GuideTile({ activity }: { activity: ActivityCard }) {
  return (
    <a class="guide" href={`/activity/${encodeURIComponent(activity.id)}`}>
      <span class="guide-emoji" aria-hidden="true">
        {activity.emoji}
      </span>
      <span class="guide-project">{activity.project}</span>
      <span class="guide-title">{activity.title}</span>
      <span class="badge-row guide-badges">
        {activity.rewardType && (
          <span class="badge badge-reward">{activity.rewardType}</span>
        )}
        {activity.status && (
          <span class={`badge ${activityBadgeClass(activity.status)}`}>
            {activity.status}
          </span>
        )}
      </span>
    </a>
  );
}
