/**
 * Ключ вкладки. Список закрытый: другого источника значения нет — вкладку
 * выбирает либо таб-бар (перебор по TABS), либо карточка на «Сводке», либо
 * клавиатура. Ни хеша, ни deep link, ни ответа сервера здесь не участвует.
 */
export type TabKey =
  | "dashboard"
  | "tasks"
  | "approvals"
  | "agents"
  | "perms"
  | "logs"
  | "wiki"
  | "settings"
  | "mac";

/**
 * Вкладки в порядке показа. Живут рядом с арифметикой перехода, а не в
 * App.tsx: тест обязан сверять с этим списком и разметку, и типы вызывающих,
 * а импортировать App.tsx ради константы нельзя — он тянет за собой девять
 * lazy-страниц.
 */
export const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: "dashboard", label: "Сводка", icon: "◉" },
  { key: "tasks", label: "Задачи", icon: "☑" },
  { key: "approvals", label: "Аппрувы", icon: "✓" },
  { key: "agents", label: "Агенты", icon: "◆" },
  { key: "perms", label: "Права", icon: "⚙" },
  { key: "logs", label: "Логи", icon: "≡" },
  { key: "wiki", label: "Вики", icon: "📖" },
  { key: "settings", label: "Настройки", icon: "⚙️" },
  { key: "mac", label: "Mac", icon: "💻" },
];

/**
 * Арифметика перехода по вкладкам стрелками (WAI-ARIA tablist).
 *
 * Вынесена из JSX, чтобы её можно было проверить тестом: DOM-харнесса у Mini
 * App нет, а именно здесь пряталось «застревание» навигации с клавиатуры.
 *
 * Возвращает индекс вкладки, которую надо выбрать. Если клавиша не
 * навигационная — возвращает `current` без изменений, чтобы вызывающий мог
 * сравнить и ничего не делать.
 */
export function nextTabIndex(key: string, current: number, total: number): number {
  if (total <= 0) return 0;
  // Индекс мог прийти из findIndex — тот отдаёт -1, если вкладку не нашли.
  const cur = Number.isInteger(current) && current >= 0 && current < total ? current : 0;
  if (key === "ArrowRight" || key === "ArrowDown") return (cur + 1) % total;
  if (key === "ArrowLeft" || key === "ArrowUp") return cur === 0 ? total - 1 : cur - 1;
  return cur;
}

/** Клавиши, для которых обработчик обязан позвать preventDefault. */
export function isTabNavKey(key: string): boolean {
  return (
    key === "ArrowRight" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowUp"
  );
}
