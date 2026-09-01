// Утилиты форматирования (RU-локаль).

/**
 * Scheme-allowlist для ссылок из данных (анти stored-XSS `javascript:`).
 * Возвращает url только если он http(s) после trim, иначе undefined —
 * вызывающий код тогда рендерит текст вместо ссылки.
 */
export function safeHref(url: string | undefined | null): string | undefined {
  if (typeof url !== "string") return undefined;
  const u = url.trim();
  return /^https?:\/\//i.test(u) ? u : undefined;
}

/**
 * Календарные даты форматируются в UTC, а не в поясе читателя.
 *
 * Всё, что приходит с датой-днём, привязано к полуночи UTC: разблокировки — это
 * `new Date(ts * 1000).toISOString()` из DefiLlama, дедлайны дропов приходят как
 * `…T00:00:00.000Z`. В местном поясе такая метка у читателя западнее Гринвича
 * съезжает на сутки назад: «6 февр.» из источника показывалось как «5 февр.» —
 * и там же ось разблокировок говорила «сегодня» про завтрашнее событие.
 *
 * `formatDateTime` ниже намеренно остаётся в местном поясе: это момент времени
 * («обновлено в 14:32»), а не календарный день.
 */
const dateFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const dateTimeFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return dateFmt.format(d);
}

const dateShortFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

const dateShortYearFmt = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Компактная дата — для плотных мест (ось разблокировок, дедлайны дропов), где
 * полное «12 августа 2026 г.» съедает ширину ради очевидного.
 *
 * Год показывается, только когда он не текущий. Календарь разблокировок
 * тянется до весны следующего года, и «24 мар.» рядом с «20 авг.» читалось бы
 * как ближайший март, то есть как прошедшая дата.
 */
export function formatDateShort(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const fmt =
    d.getUTCFullYear() === now.getUTCFullYear()
      ? dateShortFmt
      : dateShortYearFmt;
  return fmt.format(d);
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return dateTimeFmt.format(d);
}

/**
 * Время из ISO-строки в миллисекундах либо `null`, если строку не разобрать.
 *
 * Нужно там, где по дате сортируют. `new Date(x).getTime()` на мусоре даёт
 * `NaN`, а `NaN - NaN` — снова `NaN`: компаратор перестаёт быть согласованным,
 * и TimSort в этом случае не гарантирует порядок ВСЕГО массива, а не только
 * битой строки. Выглядело это как перемешанный календарь при переключении
 * стрелки сортировки. Явный `null` заставляет вызывающего решить, куда девать
 * такие строки (везде — в конец, при любом направлении).
 */
export function dateMs(iso: string): number | null {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Компаратор по дате: валидные — по возрастанию/убыванию, неразобранные — в
 * конец при любом направлении.
 */
export function byDate<T>(iso: (item: T) => string, asc: boolean) {
  return (a: T, b: T): number => {
    const ta = dateMs(iso(a));
    const tb = dateMs(iso(b));
    if (ta === null) return tb === null ? 0 : 1;
    if (tb === null) return -1;
    return asc ? ta - tb : tb - ta;
  };
}

export function formatPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  // Очень малые ненулевые значения не схлопываем в «0%».
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return `${n.toLocaleString("ru-RU", { maximumFractionDigits: digits })}%`;
}

/** Русская плюрализация: выбирает форму по числу (1 источник / 2 источника / 5 источников). */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} млрд`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} млн`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} тыс`;
  return `${sign}$${a.toLocaleString("ru-RU", { maximumFractionDigits: 0 })}`;
}
