import { fetchDrops } from "../api";
import { useAsync } from "../useAsync";
import type { Drop } from "../types";
import { formatDateShort, safeHref } from "../format";
import { dropBadgeClass, dropBadgeLabel } from "../badges";
import { EmptyState, ErrorState, SkeletonRows } from "../components/states";
import { IconExternal, IconArrowRight, IconGift } from "../components/icons";
import { HomeHead } from "./HomeHead";

const COUNT = 5;

/**
 * Дропы на главной — сводка-табло: одна панель, плотные строки, статус первым
 * столбцом. Карточки здесь ничего не добавляли: у дропа нет текста, ради
 * которого нужна карточка, — есть статус, срок и ссылка.
 *
 * Порядок «идёт → скоро → закончился» задаёт сервер (db.ts, listDrops).
 */
export function HomeDrops() {
  const { status, data, reload } = useAsync((signal) =>
    fetchDrops(COUNT, 0, signal),
  );
  const items = data?.items ?? [];

  return (
    <section id="drops" class="section">
      <HomeHead title="Актуальные дропы" href="/drops" linkLabel="Все дропы" />

      {status === "loading" && <SkeletonRows count={COUNT} />}
      {status === "error" && <ErrorState onRetry={reload} />}
      {status === "success" && items.length === 0 && (
        <EmptyState
          icon={IconGift}
          text="Сейчас активных дропов нет. Загляни позже — добавляем по мере появления"
        />
      )}

      {items.length > 0 && (
        <div class="board">
          {items.map((d) => (
            <BoardRow key={d.id} drop={d} />
          ))}
          <a class="board-row board-more" href="/drops">
            Все дропы и квесты <IconArrowRight />
          </a>
        </div>
      )}
    </section>
  );
}

function BoardRow({ drop }: { drop: Drop }) {
  const href = safeHref(drop.url);
  const deadline =
    drop.deadline && !isNaN(Date.parse(drop.deadline))
      ? `${drop.status === "ended" ? "закончился" : "до"} ${formatDateShort(drop.deadline)}`
      : null;

  return (
    <div class="board-row">
      {/* status приходит из БД как свободный TEXT: класс берём из списка
          (badges.ts), а подпись показываем как есть — незнакомое значение
          должно проявить себя, а не превратиться в пустой бейдж. */}
      <span class={`badge ${dropBadgeClass(drop.status)}`}>
        {dropBadgeLabel(drop.status)}
      </span>
      <span class="board-project">{drop.project}</span>
      <p class="board-desc">{drop.description}</p>
      <span class="board-deadline">{deadline ?? ""}</span>
      {href ? (
        <a
          class="board-open"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Открыть ${drop.project}`}
        >
          Открыть <IconExternal />
        </a>
      ) : (
        <span class="board-open board-open-off" aria-hidden="true" />
      )}
    </div>
  );
}
