// Типы строго по контракту API (см. web3-puls-product.md).

export interface DigestItem {
  text: string;
  url?: string;
}

export interface Digest {
  id: string;
  title: string;
  date: string; // ISO
  summary: string;
  body?: string; // полный текст статьи (markdown), необязательный
  items: DigestItem[];
  sourceCount: number;
}

export interface DigestsResponse {
  items: Digest[];
  total: number;
}

export interface Unlock {
  project: string;
  symbol: string;
  date: string; // ISO
  pctOfSupply: number;
  amountUsd: number | null;
}

export interface UnlocksResponse {
  items: Unlock[];
  /** Сколько разблокировок впереди всего — чтобы знать, есть ли что догружать. */
  total: number;
  /** ISO последней загрузки фида; null — фид не приезжал ни разу. */
  updatedAt: string | null;
}

export type DropStatus = "active" | "soon" | "ended";

export interface Drop {
  id: string;
  project: string;
  status: DropStatus;
  deadline: string | null; // ISO | null
  url: string;
  description: string;
}

export interface DropsResponse {
  items: Drop[];
  total: number;
}

export interface Activity {
  id: string;
  project: string;
  emoji: string;
  title: string;
  intro: string;
  whatIs: string;
  steps: string[];
  raised: string;
  investors: string;
  spent: string;
  time: string;
  rewardType: string;
  status: string;
  dateReceive: string;
  url: string;
  hashtags: string[];
  date: string; // ISO
}

/**
 * Карточка списка — без `whatIs` и `steps`.
 *
 * `/api/activities` их не присылает: потолки ингеста дают до ~116 КБ на
 * активность, а карточки эти поля не показывают. Полная активность приходит с
 * `/api/activities/:id` (`fetchActivity`). Тип отражает это буквально, чтобы
 * обращение к отсутствующему полю ловил `tsc`, а не пустой экран.
 */
export type ActivityCard = Omit<Activity, "whatIs" | "steps">;

export interface ActivitiesResponse {
  items: ActivityCard[];
  total: number;
}

export interface Health {
  ok: boolean;
  ts: number;
}

export interface Stats {
  digests: number;
  unlocks: number;
  drops: number;
  activities: number;
  /** ISO последней загрузки фида; null — фид не приезжал ни разу. */
  updatedAt: string | null;
}
