/**
 * T-718: TGStat API клиент — статистика Telegram-каналов для SMM.
 *
 * Токен лениво из env TGSTAT_TOKEN (на VPS в /opt/agent-team/.env).
 * Базовый тариф TGStat отдаёт стату только по СВОИМ/добавленным каналам;
 * чужие → error quota_foreign_channel (пробрасываем понятным текстом).
 */
import { fetchJson } from "./http.ts";

const TGSTAT_API = "https://api.tgstat.ru";
/** Потолок на длину внешних строк (title/username канала). */
const MAX_NAME_CHARS = 120;

/** Нормализовать вход в @username: @x, x, t.me/x, https://t.me/x → @x. */
export function parseChannelId(input: string): string | null {
  let s = (input ?? "").trim();
  if (!s) return null;
  const m = s.match(/t\.me\/([A-Za-z0-9_]{3,})/);
  if (m) s = m[1];
  s = s.replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{3,40}$/.test(s)) return null;
  return `@${s}`;
}

export interface ChannelStats {
  title?: string;
  username?: string;
  participants: number;
  avgPostReach: number;
  dailyReach: number;
  erPercent: number;
  err24Percent: number;
  postsCount: number;
  mentionsCount: number;
  forwardsCount: number;
  ciIndex: number;
}

/**
 * Чистая функция: из TGStat /channels/stat response собрать проекцию (тестируемо).
 *
 * Аудит 2026-08-20: `title` и `username` — единственные текстовые поля здесь, и
 * оба пишет владелец чужого канала. Уезжали в контекст модели без потолка (тот
 * же класс, что и имена страниц в figma.ts). Числа кап не требуют.
 */
export function shapeChannelStats(r: Record<string, unknown>): ChannelStats {
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const str = (v: unknown) =>
    typeof v === "string" ? v.slice(0, MAX_NAME_CHARS) : undefined;
  return {
    title: str(r.title),
    username: str(r.username),
    participants: num(r.participants_count),
    avgPostReach: num(r.avg_post_reach),
    dailyReach: num(r.daily_reach),
    erPercent: num(r.er_percent),
    err24Percent: num(r.err24_percent),
    postsCount: num(r.posts_count),
    mentionsCount: num(r.mentions_count),
    forwardsCount: num(r.forwards_count),
    ciIndex: num(r.ci_index),
  };
}

export function tgstatConfigured(): boolean {
  return !!process.env.TGSTAT_TOKEN;
}

/** Скачать статистику канала. Бросает Error с понятным текстом. */
export async function fetchChannelStats(channelId: string): Promise<ChannelStats> {
  const token = process.env.TGSTAT_TOKEN;
  if (!token) throw new Error("TGSTAT_TOKEN is not set");
  const url =
    `${TGSTAT_API}/channels/stat?token=${encodeURIComponent(token)}` +
    `&channelId=${encodeURIComponent(channelId)}`;
  // fetchJson centralizes timeout + size-cap (SEC-audit). TGStat returns 200 with
  // {status:"error"} for app-level errors, handled below.
  const json = await fetchJson<{
    status?: string;
    error?: string;
    response?: Record<string, unknown>;
  }>(url, { label: "tgstat", maxBytes: 3_000_000 });
  if (json.status !== "ok" || !json.response) {
    const err = json.error ?? "unknown";
    const hint =
      err === "quota_foreign_channel"
        ? " (тариф TGStat не даёт стату по этому каналу — только свои/добавленные)"
        : "";
    throw new Error(`tgstat: ${err}${hint}`);
  }
  return shapeChannelStats(json.response);
}
