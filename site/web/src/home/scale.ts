// Расчёты для оси разблокировок на главной: «через сколько» и длина полосы.
// Вынесено из компонента, потому что и то и другое — арифметика с краями
// (полночь, DST, null-суммы), которую надо проверять тестами, а не глазами.

import { plural } from "../format";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Полночь UTC — граница суток, а не момент «минус 24 часа».
 *
 * Именно UTC, а не пояс читателя: даты разблокировок приходят из DefiLlama
 * привязанными к полуночи UTC, и в местном поясу западнее Гринвича событие
 * попадало в предыдущие сутки — ось говорила «сегодня» про то, что источник
 * (и соседняя подпись `formatDateShort`) называет завтрашним днём.
 */
function startOfDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Сколько календарных суток до даты. Отрицательное — дата прошла, null —
 * строка не разбирается. Округление, а не floor: обе границы уже полночь UTC,
 * так что деление точное, но округление страхует от дробных смещений в данных.
 */
export function daysUntil(iso: string, now: Date = new Date()): number | null {
  const t = new Date(iso);
  if (isNaN(t.getTime())) return null;
  return Math.round((startOfDay(t) - startOfDay(now)) / DAY_MS);
}

/**
 * Подпись слева на оси. Пустая строка = подписи нет: для прошедшего, мусора и
 * всего, что дальше двух недель, где точная дата информативнее «через 47 дней».
 */
export function relativeDay(iso: string, now: Date = new Date()): string {
  const d = daysUntil(iso, now);
  if (d === null || d < 0 || d > 13) return "";
  if (d === 0) return "сегодня";
  if (d === 1) return "завтра";
  return `через ${d} ${plural(d, "день", "дня", "дней")}`;
}

/**
 * Класс узла на оси: `is-today` — сегодня, `is-soon` — ближайшие две недели,
 * пусто — всё остальное (включая прошедшее и неразобранные даты).
 *
 * Правило то же, что у `relativeDay`, и это не совпадение: узел красится ровно
 * тогда, когда слева есть словесная подпись. Иначе цвет и текст говорили бы
 * разное. Без этой функции стиль `.axis-row::before` описывал в комментарии
 * раскраску по близости события, а рисовал все пять узлов одинаково серыми —
 * то есть единственный сигнал срочности на главной был выключен.
 */
export function axisTone(iso: string, now: Date = new Date()): string {
  const d = daysUntil(iso, now);
  if (d === null || d < 0 || d > 13) return "";
  return d === 0 ? "is-today" : "is-soon";
}

/** Ниже этого полоса неотличима от её отсутствия — см. тест про $3 млн против $2 млрд. */
const MIN_VISIBLE = 0.06;

/**
 * Доли 0…1 для полос: нормировка по максимуму видимого окна. Абсолютная шкала
 * здесь бесполезна — читателю важно, какая из пяти ближайших разблокировок
 * крупная. Отсутствующая сумма даёт ровно 0: полосы не будет.
 */
export function magnitudes(
  amounts: readonly (number | null | undefined)[],
): number[] {
  const ok = (v: number | null | undefined): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;
  let max = 0;
  for (const a of amounts) if (ok(a) && a > max) max = a;
  if (max <= 0) return amounts.map(() => 0);
  return amounts.map((a) => (ok(a) ? Math.max(MIN_VISIBLE, a / max) : 0));
}
