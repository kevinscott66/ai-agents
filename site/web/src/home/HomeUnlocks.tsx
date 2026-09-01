import { fetchUnlocks } from "../api";
import { useAsync } from "../useAsync";
import { byDate, formatDateShort, formatPct, formatUsd } from "../format";
import { EmptyState, ErrorState, SkeletonRows } from "../components/states";
import { IconLockOpen } from "../components/icons";
import { HomeHead } from "./HomeHead";
import { axisTone, magnitudes, relativeDay } from "./scale";

const COUNT = 5;

/**
 * Разблокировки на главной — ось времени, а не таблица.
 *
 * Таблица отвечает на вопрос «какие есть значения», а здесь вопрос другой:
 * «когда рынку станет тяжело и насколько». Поэтому слева расстояние во времени,
 * справа — полоса, длина которой пропорциональна сумме относительно самой
 * крупной из показанных. Полная таблица со всеми колонками осталась в разделе.
 */
export function HomeUnlocks() {
  const { status, data, reload } = useAsync((signal) =>
    fetchUnlocks(COUNT, 0, signal),
  );

  // Сортировка через byDate, а не вычитанием getTime(): на неразобранной дате
  // вычитание даёт NaN, и порядок всей оси становится неопределённым.
  const items = data?.items ? [...data.items].sort(byDate((u) => u.date, true)) : [];
  const mags = magnitudes(items.map((u) => u.amountUsd));

  return (
    <section id="unlocks" class="section">
      <HomeHead
        title="Ближайшие разблокировки"
        sub="Когда в рынок выйдут залоченные токены и на какую сумму. Данные DefiLlama."
        href="/unlocks"
        linkLabel="Весь календарь"
      />

      {status === "loading" && <SkeletonRows count={COUNT} />}
      {status === "error" && <ErrorState onRetry={reload} />}
      {status === "success" && items.length === 0 && (
        <EmptyState
          icon={IconLockOpen}
          text="Данных по разблокировкам пока нет — подтянем со следующим обновлением"
        />
      )}

      {items.length > 0 && (
        <ol class="axis">
          {items.map((u, i) => {
            const rel = relativeDay(u.date);
            const abs = formatDateShort(u.date);
            const pct = Math.round(mags[i] * 100);
            return (
              <li
                class={`axis-row ${axisTone(u.date)}`.trim()}
                key={`${u.symbol}-${u.date}-${i}`}
              >
                <div class="axis-when">
                  {rel && <span class="axis-rel">{rel}</span>}
                  <span class="axis-date">{abs}</span>
                </div>
                <div class="axis-what">
                  <span class="axis-project">{u.project}</span>
                  <span class="ticker">{u.symbol}</span>
                </div>
                <div class="axis-mag">
                  <span class="axis-sum">{formatUsd(u.amountUsd)}</span>
                  {/* Полоса — иллюстрация к уже написанной сумме, поэтому
                      скрыта от скринридера, а не подписана вторым числом. */}
                  <span class="axis-bar" aria-hidden="true">
                    <span class="axis-bar-fill" style={`width:${pct}%`} />
                  </span>
                  <span class="axis-pct">{formatPct(u.pctOfSupply)} от выпуска</span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
