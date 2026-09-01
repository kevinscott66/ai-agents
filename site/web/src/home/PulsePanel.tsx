import { fetchStats } from "../api";
import { useAsync } from "../useAsync";
import { formatDate } from "../format";

interface Metric {
  value: number | null;
  label: string;
  href: string;
}

/**
 * «Пульс» — правая колонка hero: четыре цифры проекта крупно.
 *
 * Пришло на смену горизонтальной плашке `StatsBar`, которая при ошибке
 * /api/stats просто исчезала. Здесь панель — часть сетки hero, и её пропажа
 * оставила бы дыру, поэтому неудача рисуется прочерками: «не знаем» честнее
 * пустоты и не двигает вёрстку.
 */
export function PulsePanel() {
  const { status, data } = useAsync((signal) => fetchStats(signal));

  const metrics: Metric[] = [
    { value: data?.digests ?? null, label: "дайджестов", href: "/digests" },
    { value: data?.unlocks ?? null, label: "разблокировок", href: "/unlocks" },
    { value: data?.drops ?? null, label: "дропов", href: "/drops" },
    { value: data?.activities ?? null, label: "гайдов", href: "/activities" },
  ];

  // formatDate вернул бы сырую строку при невалидной дате — сравнение с
  // исходником это ловит. updatedAt = null, когда фид не приезжал ни разу.
  const updated = data?.updatedAt ? formatDate(data.updatedAt) : null;
  const showUpdated = updated !== null && updated !== data?.updatedAt;

  return (
    <aside class="pulse" aria-label="Сводка по данным проекта">
      <p class="pulse-cap">Пульс проекта</p>
      <div class="pulse-grid">
        {metrics.map((m) => (
          <a class="pulse-cell" href={m.href} key={m.label}>
            <span class={`pulse-num${status === "loading" ? " is-pending" : ""}`}>
              {m.value === null ? "—" : m.value}
            </span>
            <span class="pulse-label">{m.label}</span>
          </a>
        ))}
      </div>
      {showUpdated && <p class="pulse-foot">обновлено {updated}</p>}
    </aside>
  );
}
