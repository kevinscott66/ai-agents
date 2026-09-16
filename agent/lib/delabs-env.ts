/**
 * Настройки публикации DeLabs, прочитанные из окружения.
 *
 * Аудит 2026-08-28: три юнита (`deploy/systemd/delabs-{daily,weekly}-draft`,
 * `delabs-approve-poll`) поднимают окружение через `EnvironmentFile=`, а он для
 * строки `KEY=` кладёт ПУСТУЮ строку, а не отсутствие ключа. `??` на пустую
 * строку не срабатывает — и все три тула читали свои настройки так:
 *
 *   process.env.DELABS_SITE_BASE ?? "https://delabs.space"   → ""
 *   Number(process.env.DELABS_CHANNEL_ID ?? "-1004471352065") → Number("") === 0
 *
 * Последствия ровно на пути в канал: адрес пункта собирается как
 * `${SITE_BASE}/digest/${id}` и получается «/digest/1» без схемы — Telegram
 * отвечает «unsupported URL protocol» и не отправляет ВЕСЬ пост (защиту от
 * такого адреса поставили в lib/delabs-post-templates.ts, но источник был
 * здесь); `fetch("/api/digests?limit=100")` бросает на относительном адресе;
 * публикация уходит в чат 0. При этом `.env.example` обещал обратное — «Пусто
 * = -1004471352065».
 *
 * Правильное поведение — фолбэк по ПУСТОЙ строке, а не по `undefined`
 * (прецеденты: `parseAdminUserIds` в lib/admin-commands.ts — там тернарник
 * `tg ? tg : …`, и соседний `siteIngestChannelId` в lib/site-ingest.ts — там
 * `||`). Собрано в одном месте, потому
 * что читателей три и расходиться им незачем.
 */
import { log } from "./log.ts";

/** Публичный канал DeLabs. Тот же id — дефолт моста на сайт. */
export const DEFAULT_DELABS_CHANNEL_ID = -1004471352065;
export const DEFAULT_DELABS_SITE_BASE = "https://delabs.space";
export const DEFAULT_DELABS_PENDING_PATH = "/opt/web3-puls/drafts/pending.json";

/** Канал, в который публикуют daily-draft и approve-poll. */
export function delabsChannelId(): number {
  const raw = process.env.DELABS_CHANNEL_ID?.trim() || "";
  if (!raw) return DEFAULT_DELABS_CHANNEL_ID;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) {
    log.warn("[delabs] DELABS_CHANNEL_ID не число — беру канал по умолчанию", { raw });
    return DEFAULT_DELABS_CHANNEL_ID;
  }
  return n;
}

/**
 * База адресов сайта — без хвостового слэша, потому что все три тула клеят
 * `${base}/digest/${id}` вручную.
 *
 * Схему проверяем здесь, а не у потребителя: значение без `http(s)://` даёт
 * ссылку, на которой Telegram роняет весь пост, и относительный fetch. Молча
 * подставить дефолт лучше, чем опубликовать битую ссылку, но в лог пишем —
 * иначе опечатка в .env остаётся невидимой.
 */
export function delabsSiteBase(): string {
  const raw = process.env.DELABS_SITE_BASE?.trim() || "";
  if (!raw) return DEFAULT_DELABS_SITE_BASE;
  if (!/^https?:\/\/[^\s/]+/i.test(raw)) {
    log.warn("[delabs] DELABS_SITE_BASE без схемы — беру адрес по умолчанию", { raw });
    return DEFAULT_DELABS_SITE_BASE;
  }
  return raw.replace(/\/+$/, "");
}

/** Файл черновика, который daily-draft пишет, а approve-poll забирает. */
export function delabsPendingPath(): string {
  return process.env.DELABS_DRAFTS_PENDING?.trim() || DEFAULT_DELABS_PENDING_PATH;
}
