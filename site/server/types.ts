// Shared API types — must match the contract in
// .claude/memory/notes/web3-puls-product.md exactly.

export type DigestItem = { text: string; url?: string };

export type Digest = {
  id: string;
  title: string;
  date: string; // ISO
  summary: string;
  body?: string; // полный текст статьи (markdown), необязательный
  items: DigestItem[];
  sourceCount: number;
};

export type Unlock = {
  project: string;
  symbol: string;
  date: string; // ISO
  pctOfSupply: number;
  amountUsd: number | null;
};

export type DropStatus = "active" | "soon" | "ended";

export type Drop = {
  id: string;
  project: string;
  status: DropStatus;
  deadline: string | null; // ISO or null
  url: string;
  description: string;
};

/**
 * Активность в списке — без `whatIs` и `steps`.
 *
 * Аудит 2026-08-20: `/api/activities` отдавал строки целиком. Потолки ингеста
 * дают 8 000 символов на `whatIs` и 50 × 2 000 на `steps` — то есть до ~116 КБ
 * на карточку и до ~11,6 МБ на ответ при `limit=100`, который синхронный
 * `JSON.stringify` собирает в единственном потоке, где живёт весь сайт.
 * Карточки эти поля не показывают (см. ActivitiesPage / HomeActivities:
 * emoji, project, title, intro, rewardType, status), а полная активность
 * по-прежнему доступна на `/api/activities/:id`.
 *
 * Поля именно ОТСУТСТВУЮТ, а не приезжают пустыми: пустой `steps: []` читался
 * бы как «у гайда нет шагов».
 */
export type ActivityCard = Omit<Activity, "whatIs" | "steps">;

export type Activity = {
  id: string;
  project: string;
  emoji: string; // эмодзи для шапки, напр "🤗"
  title: string; // заголовок-действие
  intro: string; // вступительный абзац
  whatIs: string; // описание «что такое проект»
  steps: string[]; // нумерованные шаги
  raised: string; // Собрано, напр "$23,5 млн" или "N/A"
  investors: string; // Фонды и Инвесторы
  spent: string; // Траты, напр "$0"
  time: string; // Время, напр "9 мин"
  rewardType: string; // напр "Аирдроп"
  status: string; // напр "Подтверждено"
  dateReceive: string; // Дата получения, напр "TBA"
  url: string; // главная ссылка проекта
  hashtags: string[];
  date: string; // ISO
};
