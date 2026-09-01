/**
 * Telegram theme sync (M3): parse `Telegram.WebApp.themeParams` and write to
 * CSS custom properties on :root. Listens to `themeChanged` events.
 */

export interface TgThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  destructive_text_color?: string;
}

const VAR_MAP: Record<keyof TgThemeParams, string> = {
  bg_color: "--tg-bg",
  text_color: "--tg-text",
  hint_color: "--tg-hint",
  link_color: "--tg-link",
  button_color: "--tg-button",
  button_text_color: "--tg-button-text",
  secondary_bg_color: "--tg-secondary-bg",
  header_bg_color: "--tg-header-bg",
  accent_text_color: "--tg-accent-text",
  destructive_text_color: "--tg-destructive-text",
};

/** Pure helper — convert themeParams into CSS variable map. */
export function themeParamsToVars(
  params: TgThemeParams | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!params || typeof params !== "object") return out;
  for (const k of Object.keys(VAR_MAP) as (keyof TgThemeParams)[]) {
    const v = params[k];
    if (typeof v === "string" && v) out[VAR_MAP[k]] = v;
  }
  return out;
}

/**
 * Светлая или тёмная тема — для нативной хромы браузера.
 *
 * Аудит 2026-08-21: `color-scheme` не был объявлен нигде — ни в `styles.css`,
 * ни в `index.html`. CSS красит только закрытый контрол; выпадающий список
 * `<select>` рисует не страница, а движок, и без `color-scheme` он рисует его
 * по светлому умолчанию. В тёмной теме Telegram одиннадцать выпадашек
 * открывались белым листом, каретка в полях и подсветка выделения оставались
 * светлыми, а `<select>` в карточке агента (единственный без CSS-правила)
 * был просто белой коробкой на тёмном фоне.
 *
 * Порядок источников:
 *   1. `Telegram.WebApp.colorScheme` — Telegram знает свою тему точно;
 *   2. яркость `bg_color` — если поле есть, а `colorScheme` почему-то нет;
 *   3. `null` — не угадываем. В `styles.css` объявлено `color-scheme: light
 *      dark`, то есть без нашей подсказки хрома пойдёт за системной темой.
 *      Это может разойтись с темой Telegram, но никогда не залипает светлым.
 */
export function colorSchemeOf(
  params: TgThemeParams | null | undefined,
  declared?: unknown,
): "dark" | "light" | null {
  if (declared === "dark" || declared === "light") return declared;
  const bg = params && typeof params === "object" ? params.bg_color : undefined;
  const lum = perceivedBrightness(bg);
  if (lum === null) return null;
  // 128 из 255 — обычный порог воспринимаемой яркости (ITU-R BT.601).
  return lum < 128 ? "dark" : "light";
}

/** Яркость `#rgb`/`#rrggbb` в 0..255, либо null, если это не цвет. */
function perceivedBrightness(hex: unknown): number | null {
  if (typeof hex !== "string") return null;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Проставить `color-scheme` на элемент (по умолчанию :root). */
export function applyColorScheme(
  scheme: "dark" | "light" | null,
  target?: HTMLElement,
): void {
  if (!scheme) return;
  const el = target ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el) return;
  el.style.setProperty("color-scheme", scheme);
}

/** Write vars onto a target element (default :root). */
export function applyThemeVars(
  vars: Record<string, string>,
  target?: HTMLElement,
): void {
  const el = target ?? (typeof document !== "undefined" ? document.documentElement : null);
  if (!el) return;
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}

/** Read current Telegram themeParams and apply once. Returns vars applied. */
export function syncThemeFromTelegram(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const wa = (window as any).Telegram?.WebApp;
  const vars = themeParamsToVars(wa?.themeParams);
  applyThemeVars(vars);
  // Вместе с переменными — и нативная хрома, иначе выпадашки останутся
  // светлыми. Здесь, а не разово при старте: `themeChanged` зовёт эту же
  // функцию, и переключение темы в Telegram должно доезжать целиком.
  applyColorScheme(colorSchemeOf(wa?.themeParams, wa?.colorScheme));
  return vars;
}

/** Initialise theme sync + subscribe to `themeChanged`. */
export function initTelegramTheme(): () => void {
  if (typeof window === "undefined") return () => {};
  const wa = (window as any).Telegram?.WebApp;
  syncThemeFromTelegram();
  if (!wa?.onEvent) return () => {};
  const handler = () => syncThemeFromTelegram();
  try {
    wa.onEvent("themeChanged", handler);
  } catch {}
  return () => {
    try {
      wa.offEvent?.("themeChanged", handler);
    } catch {}
  };
}
