import { API_BASE } from "./config";
import type {
  Activity,
  ActivitiesResponse,
  Digest,
  DigestsResponse,
  DropStatus,
  DropsResponse,
  Stats,
  UnlocksResponse,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("Сеть недоступна", 0);
  }
  if (!res.ok) {
    throw new ApiError(`Ошибка ${res.status}`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError("Некорректный ответ сервера", res.status);
  }
}

export function fetchDigests(
  limit: number,
  offset: number,
  signal?: AbortSignal,
  q?: string,
): Promise<DigestsResponse> {
  const query = q && q.trim() ? `&q=${encodeURIComponent(q.trim())}` : "";
  return getJson<DigestsResponse>(
    `/digests?limit=${limit}&offset=${offset}${query}`,
    signal,
  );
}

export function fetchDigest(
  id: string,
  signal?: AbortSignal,
): Promise<Digest> {
  return getJson<Digest>(`/digests/${encodeURIComponent(id)}`, signal);
}

export function fetchUnlocks(
  limit: number,
  offset = 0,
  signal?: AbortSignal,
  opts: { desc?: boolean; withinDays?: number } = {},
): Promise<UnlocksResponse> {
  // Сортировку и окно считает сервер: на клиенте они применялись к уже
  // загруженному куску, то есть «7 дней» показывали не все разблокировки
  // недели, а только те из первой сотни, что в неделю попали.
  const order = opts.desc ? "&order=desc" : "";
  const within = opts.withinDays ? `&within=${opts.withinDays}` : "";
  return getJson<UnlocksResponse>(
    `/unlocks?limit=${limit}&offset=${offset}${order}${within}`,
    signal,
  );
}

export function fetchDrops(
  limit: number,
  offset = 0,
  signal?: AbortSignal,
  status?: DropStatus | "all",
): Promise<DropsResponse> {
  // "all" и пустое — это отсутствие фильтра; сервер незнакомое значение и так
  // игнорирует, но незачем гонять его по проводу.
  const s = status && status !== "all" ? `&status=${status}` : "";
  return getJson<DropsResponse>(
    `/drops?limit=${limit}&offset=${offset}${s}`,
    signal,
  );
}

export function fetchActivities(
  limit: number,
  offset: number,
  signal?: AbortSignal,
): Promise<ActivitiesResponse> {
  return getJson<ActivitiesResponse>(
    `/activities?limit=${limit}&offset=${offset}`,
    signal,
  );
}

export function fetchActivity(
  id: string,
  signal?: AbortSignal,
): Promise<Activity> {
  return getJson<Activity>(`/activities/${encodeURIComponent(id)}`, signal);
}

export function fetchStats(signal?: AbortSignal): Promise<Stats> {
  return getJson<Stats>(`/stats`, signal);
}
