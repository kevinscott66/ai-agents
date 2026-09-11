/**
 * Дизайнерский баннер-превью для постов канала: чёткий SVG → PNG (resvg), с
 * настоящим текстом (заголовок, дата, тег) и фирменным логотипом DeLabs. Это НЕ
 * ИИ-картинка — это свёрстанный баннер в бренд-стиле (тёмный фон, неоновые
 * акценты), поэтому текст резкий и читаемый, без артефактов генеративных моделей.
 *
 * Шрифты — фирменные: Unbounded (display, заголовок) + Manrope (тег/дата/подзаголовок).
 * resvg-js не инстанцирует variable-шрифты, поэтому в assets/fonts/ лежат статические
 * TTF (веса 400/600/800), которые мы прокидываем в Resvg через { font: { fontFiles } }.
 * Если файлов шрифтов нет — fallback на системный sans-serif.
 *
 * Логотип — прозрачный PNG (assets/delabs-logo-transparent.png, копия site logo.png),
 * рисуется без круглого клипа, в правом-верхнем углу, с мягким свечением.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { escapeXml } from "./svg-render.ts";
import { log } from "./log.ts";

export interface BannerOpts {
  title: string;
  subtitle?: string;
  date?: string;
  tag?: string; // напр. "AI × Web3"
}

// 1080p-класс для резкого текста (рендерим в ширину W; resvg лимит 2048).
const W = 1920;
const H = 1008;
const PADX = 140; // левый отступ контента
const BAR_X = 84; // фиолетовый бар — левее контента, с зазором
// Бренд-шрифты (с фолбэками на случай отсутствия TTF в сборке).
const FONT_DISPLAY = "Unbounded, Manrope, Arial, sans-serif";
const FONT_TEXT = "Manrope, Arial, Helvetica, sans-serif";

/** Статические TTF бренд-шрифтов для resvg (variable-шрифты resvg-js не инстанцирует). */
let FONT_FILES: string[] | undefined;
/** Экспортирована ради теста: путь к шрифтам иначе проверить нечем. */
export function fontFiles(): string[] {
  if (FONT_FILES !== undefined) return FONT_FILES;
  const names = [
    "unbounded-800.ttf",
    "unbounded-600.ttf",
    "manrope-800.ttf",
    "manrope-600.ttf",
    "manrope-400.ttf",
  ];
  const out: string[] = [];
  for (const n of names) {
    try {
      // Аудит 2026-08-20: было `url.pathname`. Он отдаёт путь В ПРОЦЕНТНОЙ
      // КОДИРОВКЕ и обрывается на `#`/`?`: репозиторий в каталоге с пробелом
      // даёт «/Users/…/ai%20agents/…», readFileSync такого файла не находит,
      // catch ниже это проглатывает — и так все пять бренд-шрифтов молча
      // исчезают. Resvg тогда рисует системным шрифтом, баннер выглядит совсем
      // иначе, и в логах об этом ни строки.
      const p = fileURLToPath(new URL(`../assets/fonts/${n}`, import.meta.url));
      readFileSync(p); // существует?
      out.push(p);
    } catch {
      /* нет файла — пропускаем, fallback на системный шрифт */
    }
  }
  if (!out.length) {
    // Пустой список — не «мелочь»: это тихая подмена фирменного вида системным.
    log.warn("[cover-banner] бренд-шрифты не найдены, рендер уйдёт на системные");
  }
  FONT_FILES = out;
  return FONT_FILES;
}

let LOGO_DATA_URI: string | null | undefined;
function logoDataUri(): string | null {
  if (LOGO_DATA_URI !== undefined) return LOGO_DATA_URI;
  try {
    const url = new URL("../assets/delabs-logo-transparent.png", import.meta.url);
    const buf = readFileSync(url);
    LOGO_DATA_URI = `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    LOGO_DATA_URI = null;
  }
  return LOGO_DATA_URI;
}

/**
 * Аудит 2026-08-11: здесь была своя копия, экранировавшая только `& < >`.
 * Для `<text>`-содержимого этого хватало, но копия была вторым по счёту
 * экранировщиком SVG в репозитории (второй — designer/svg-templates.ts — не
 * экранировал вообще). Общая версия покрывает ещё и кавычки.
 */
const esc = escapeXml;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Подзаголовок часто дублирует дату («ИИ и крипта — 13 июня 2026», а дата
 * рендерится ещё и отдельной строкой). Срезаем дату из хвоста подзаголовка:
 * сначала ровно ту, что в `date`, затем любой «число месяц год» в конце.
 */
function dedupeSubtitleDate(subtitle: string, date?: string): string {
  let s = subtitle.trim();
  if (date && date.trim()) {
    s = s.replace(new RegExp(`[\\s—–\\-|·,]*${escapeRegex(date.trim())}\\s*$`), "").trim();
  }
  s = s.replace(/[\s—–\-|·,]*\d{1,2}\s+[а-яёa-z]+\.?\s+\d{4}\s*$/i, "").trim();
  return s;
}

// Зона логотипа (правый-верхний угол) — заголовок не должен в неё заходить по X.
const LOGO_SIZE = 196;
const LOGO_MARGIN = 90;
const LOGO_LEFT = W - LOGO_MARGIN - LOGO_SIZE; // ≈ 1634
// Доступная ширина под заголовок: от левого отступа до левого края лого с зазором.
// Так текст НИКОГДА не заходит в зону лого по X, на любой высоте строки.
const TITLE_GAP = 70; // зазор до лого
const TITLE_AVAIL_W = LOGO_LEFT - TITLE_GAP - PADX; // ≈ 1424

// Unbounded — геометрический display-шрифт, заметно шире DejaVu: ≈0.74·fontSize
// на символ в ExtraBold. Используем для оценки переноса/кегля.
const TITLE_CHAR_W = 0.74;

/**
 * Перенос по словам с учётом РЕАЛЬНОЙ ширины (оценка по кеглю; Unbounded ExtraBold
 * ≈ TITLE_CHAR_W·fontSize на символ). Возвращает null, если на этом кегле не
 * влезает в maxLines строк (или есть слово шире строки) — тогда подбираем кегль меньше.
 */
function wrapByWidth(
  text: string,
  fontSize: number,
  availW: number,
  maxLines: number,
): string[] | null {
  const maxChars = Math.max(6, Math.floor(availW / (fontSize * TITLE_CHAR_W)));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (w.length > maxChars) return null; // одиночное слово не влезает
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length > maxLines) return null;
    }
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

/** Кегль подзаголовка и оценка ширины символа для Manrope 600. */
const SUB_SIZE = 40;
const SUB_CHAR_W = 0.56;

/**
 * Обрезать подзаголовок по ширине холста.
 *
 * Аудит 2026-08-20: подзаголовок не обрезался вообще. build-payload режет его
 * до 160 символов, а 160 знаков на кегле 40 — это ≈3600 точек при доступных
 * ≈1424 на чистом баннере: строка уходила далеко за правый край. Заголовок от
 * этого защищён авто-фитом, подзаголовок не был ничем.
 */
function fitSubtitle(sub: string, availW: number): string {
  const maxChars = Math.max(8, Math.floor(availW / (SUB_SIZE * SUB_CHAR_W)));
  const chars = Array.from(sub);
  if (chars.length <= maxChars) return sub;
  return chars.slice(0, maxChars - 1).join("").trimEnd() + "…";
}

/**
 * Подобрать максимальный кегль, при котором заголовок ВЛЕЗАЕТ ЦЕЛИКОМ (без обрезки).
 *
 * Аудит 2026-08-20: ширина стала аргументом. Раньше она была зашита в
 * TITLE_AVAIL_W, посчитанную из чистого баннера 1920 (≈1424), а иллюстрированный
 * баннер — путь по умолчанию — шириной 1536 и с текстом, сдвинутым на
 * PADX + TITLE_SHIFT_X = 174, реально имеет под заголовок меньше. Подгонка
 * «влезает целиком» мерила не тот холст и разрешала строки, уходящие за правый
 * край: «Аирдропы недели: что забрать прямо сейчас» на кегле 116 даёт строку
 * шириной ≈1373, то есть правый край на 1547 при холсте 1536. Обрезка была
 * видна на растре — белые пиксели упирались в последний столбец.
 */
function fitTitle(
  title: string,
  availW: number = TITLE_AVAIL_W,
): { lines: string[]; size: number } {
  for (let size = 116; size >= 54; size -= 4) {
    const lines = wrapByWidth(title, size, availW, 4);
    if (lines) return { lines, size };
  }
  // Крайний случай (очень длинное слово): жёсткий перенос на минимальном кегле.
  const size = 54;
  const maxChars = Math.max(6, Math.floor(availW / (size * TITLE_CHAR_W)));
  // Аудит 2026-08-20: режем ПО КОДОВЫМ ТОЧКАМ. String.prototype.slice считает
  // единицы UTF-16, поэтому граница могла разрубить суррогатную пару пополам —
  // а одинокий суррогат делает документ невалидным XML, и Resvg отвергает его
  // целиком: терялся не эмодзи, а весь баннер. escapeXml теперь такой мусор
  // подчищает, но резать пару всё равно незачем.
  const chars = Array.from(title);
  const lines: string[] = [];
  let pos = 0;
  while (pos < chars.length && lines.length < 4) {
    lines.push(chars.slice(pos, pos + maxChars).join(""));
    pos += maxChars;
  }
  if (pos < chars.length && lines.length) {
    const last = Array.from(lines[lines.length - 1]!);
    lines[lines.length - 1] = last.slice(0, maxChars - 1).join("") + "…";
  }
  return { lines, size };
}

export function buildBannerSvg(opts: BannerOpts): string {
  // Аудит 2026-08-20: `.trim()` СНАРУЖИ — заголовок из одних пробелов проходил
  // `||` как истинный и после обрезки давал пустую строку, то есть баннер без
  // заголовка. Обрезаем до проверки.
  const title = opts.title?.trim() || "Дайджест";
  const { lines: titleLines, size: titleSize } = fitTitle(title);
  const lineH = titleSize * 1.1;
  // Заголовок центрируем по вертикали в области ниже зоны лого.
  const startY = H / 2 - ((titleLines.length - 1) * lineH) / 2 + titleSize * 0.34;

  // Плотный трекинг для маркетингового display-вида (Unbounded и так широкий).
  const titleTracking = -(titleSize * 0.018);
  const titleTspans = titleLines
    .map(
      (ln, i) =>
        `<text x="${PADX}" y="${startY + i * lineH}" font-family="${FONT_DISPLAY}" font-size="${titleSize}" font-weight="800" letter-spacing="${titleTracking.toFixed(2)}" fill="#ffffff">${esc(ln)}</text>`,
    )
    .join("\n");

  // Аудит 2026-08-20: ширина чипа считалась по ЭКРАНИРОВАННОЙ строке. Тег
  // «AT&T» после esc() — это «AT&amp;T», семь символов вместо четырёх, и чип
  // раздувался вдвое. Меряем сырой текст, подставляем экранированный.
  const tagRaw = opts.tag || "AI × Web3";
  const tag = esc(tagRaw);
  const date = opts.date ? esc(opts.date) : "";
  const subRaw = opts.subtitle ? dedupeSubtitleDate(opts.subtitle, opts.date) : "";
  const subtitle = subRaw ? esc(fitSubtitle(subRaw, TITLE_AVAIL_W)) : "";

  // Прозрачное лого: просто <image> в правом-верхнем углу, без клипа и кольца.
  // Мягкое свечение через blur-дубликат под основным изображением.
  const logo = logoDataUri();
  const logoSvg = logo
    ? `<image x="${LOGO_LEFT}" y="${LOGO_MARGIN - 18}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" href="${logo}" filter="url(#logoGlow)" opacity="0.55"/>
  <image x="${LOGO_LEFT}" y="${LOGO_MARGIN - 18}" width="${LOGO_SIZE}" height="${LOGO_SIZE}" href="${logo}"/>`
    : "";

  // Тег-чип: ширина по оценке Manrope (~0.52·fontSize/символ) + паддинги.
  const tagFont = 32;
  const tagW = Math.round(56 + tagRaw.length * tagFont * 0.56);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1020"/>
      <stop offset="1" stop-color="#05070f"/>
    </linearGradient>
    <radialGradient id="glow1" cx="0.16" cy="0.18" r="0.62">
      <stop offset="0" stop-color="#6d5cff" stop-opacity="0.50"/>
      <stop offset="1" stop-color="#6d5cff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="0.9" cy="0.9" r="0.6">
      <stop offset="0" stop-color="#16e0c8" stop-opacity="0.38"/>
      <stop offset="1" stop-color="#16e0c8" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#6d5cff"/>
      <stop offset="1" stop-color="#16e0c8"/>
    </linearGradient>
    <filter id="logoGlow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="26"/>
    </filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow1)"/>
  <rect width="${W}" height="${H}" fill="url(#glow2)"/>
  <rect x="${BAR_X}" y="118" width="12" height="${H - 236}" rx="6" fill="url(#bar)"/>
  ${logoSvg}
  <g>
    <rect x="${PADX}" y="142" width="${tagW}" height="64" rx="32" fill="#6d5cff" fill-opacity="0.16" stroke="#6d5cff" stroke-opacity="0.55"/>
    <text x="${PADX + 30}" y="184" font-family="${FONT_TEXT}" font-size="${tagFont}" font-weight="800" letter-spacing="1.5" fill="#c4bdff">${tag}</text>
  </g>
  ${titleTspans}
  ${subtitle ? `<text x="${PADX}" y="${H - 168}" font-family="${FONT_TEXT}" font-size="40" font-weight="600" fill="#9aa4bf">${subtitle}</text>` : ""}
  ${date ? `<text x="${PADX}" y="${H - 96}" font-family="${FONT_TEXT}" font-size="36" font-weight="800" letter-spacing="0.5" fill="#16e0c8">${date}</text>` : ""}
</svg>`;
}

export async function renderBannerPng(opts: BannerOpts): Promise<Buffer> {
  return renderBrandSvgToPng(buildBannerSvg(opts), W);
}

/**
 * Нужны ли системные шрифты для этого SVG.
 *
 * Аудит 2026-08-08: `loadSystemFonts: true` стоял безусловно, а resvg сканирует
 * системные шрифты ЗАНОВО на каждый инстанс. Замер на M1: 2.6с со сканом против
 * 0.75с без него — то есть каждая публикация в канал сжигала ~2 секунды
 * синхронного CPU в том же процессе, где живут SQLite и 12 ботов, ради шрифтов,
 * которые в 99% случаев не использовались: заголовок из латиницы и кириллицы
 * целиком покрыт бренд-TTF (побайтово тот же PNG — проверено хешами).
 *
 * Условие нарочно консервативное: чуть что необычное — эмодзи, стрелки, ©, CJK,
 * любой скрипт вне латиницы/кириллицы/греческого — идём прежним медленным
 * путём. Тогда картинка гарантированно не меняется, а быстрый путь берёт на
 * себя обычный заголовок.
 */
export function needsSystemFonts(svg: string): boolean {
  if (
    /[^\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]/u.test(
      svg,
    )
  ) {
    return true;
  }
  // Эмодзи и «картиночные» символы (© и ® тоже сюда) рисуются системным
  // цветным шрифтом — в бренд-TTF их нет.
  if (/\p{Extended_Pictographic}/u.test(svg)) return true;
  // Стрелки, дингбаты, разные символы: U+2190…U+2BFF.
  return /[←-⯿]/u.test(svg);
}

/**
 * Рендер баннерного SVG в PNG напрямую через Resvg с бренд-шрифтами (fontFiles).
 * Это доверенный композит (наш SVG + лого в base64), поэтому идём мимо 200KB-гарда
 * renderSvgToPng. Системные шрифты — фолбэк: грузим, если TTF не найдены или в
 * тексте есть символы вне их покрытия (см. needsSystemFonts).
 */
function renderBrandSvgToPng(svg: string, width: number): Buffer {
  const files = fontFiles();
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: Math.min(width, 2048) },
    font: {
      fontFiles: files,
      loadSystemFonts: files.length === 0 || needsSystemFonts(svg),
      defaultFontFamily: "Manrope",
    },
  });
  return Buffer.from(resvg.render().asPng());
}

/* ─────────────── Иллюстрированный баннер (фон-картинка + оверлей) ─────────────── */

// Источник-картинки 1536×1024 (3:2). Баннер рендерим в этом же соотношении,
// чтобы фон не обрезался криво.
const IW = 1536;
const IH = 1024;
/** Сдвиг текстовой группы заголовка вправо (`<g transform>` ниже). */
const TITLE_SHIFT_X = 34;
/**
 * Ширина под заголовок на иллюстрированном баннере. Симметричные поля: слева
 * PADX + сдвиг группы, справа столько же, сколько слева на чистом баннере.
 * Логотип тут в правом ВЕРХНЕМ углу и заголовку не мешает, в отличие от
 * TITLE_AVAIL_W, где зазор считается до логотипа.
 */
const ILL_TITLE_AVAIL_W = IW - PADX - TITLE_SHIFT_X - PADX;

let POOL_FILES: string[] | undefined;
function bannerPool(): string[] {
  if (POOL_FILES !== undefined) return POOL_FILES;
  try {
    const dir = new URL("../assets/banner-pool/", import.meta.url);
    // Аудит 2026-08-29: путь собираем `join`, а не `new URL(f, dir)`.
    // `readdirSync` отдаёт СЫРОЕ имя файла, а конструктор URL разбирает его как
    // ссылку: `a#b.jpg` теряет всё после решётки, `a?b.jpg` — после знака
    // вопроса, `a%41.jpg` раскодируется в `aA.jpg` (`fileURLToPath` снимает
    // проценты). Фильтр по расширению отрабатывает ДО этого, по сырому имени,
    // так что мусорный путь спокойно попадал в пул. Дальше `imgDataUri` не
    // читает несуществующий файл и молча возвращает null: пост получает чистый
    // баннер вместо иллюстрированного, без единой строчки в логе, а
    // `hasBannerPool()` при этом продолжает отвечать true. Выбор фона
    // детерминирован по seed, поэтому травится не «иногда», а всегда один и тот
    // же срез заголовков. `join` берёт имя буквально.
    const dirPath = fileURLToPath(dir);
    POOL_FILES = readdirSync(dir)
      .filter((f) => /\.(jpe?g|png)$/i.test(f))
      .sort()
      .map((f) => join(dirPath, f));
  } catch {
    POOL_FILES = [];
  }
  return POOL_FILES;
}

/** Детерминированный выбор фона из пула по seed (напр. заголовку) или индексу. */
function pickBackground(seed?: string | number): string | null {
  const pool = bannerPool();
  if (!pool.length) return null;
  let idx: number;
  if (typeof seed === "number") idx = Math.abs(Math.trunc(seed)) % pool.length;
  else if (typeof seed === "string" && seed) {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    idx = Math.abs(h) % pool.length;
  } else idx = 0;
  return pool[idx];
}

function imgDataUri(path: string): string | null {
  try {
    const buf = readFileSync(path);
    const mime = /\.png$/i.test(path) ? "image/png" : "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

export interface IllustratedBannerOpts extends BannerOpts {
  /** Seed для выбора фона из пула (детерминированно). По умолчанию — title. */
  seed?: string | number;
  /** Явный путь к фону (минуя пул). */
  backgroundPath?: string;
}

/** SVG иллюстрированного баннера: фон-картинка + тёмный скрим снизу + текст/лого. */
export function buildIllustratedBannerSvg(opts: IllustratedBannerOpts): string | null {
  const bgPath = opts.backgroundPath ?? pickBackground(opts.seed ?? opts.title);
  if (!bgPath) return null;
  const bg = imgDataUri(bgPath);
  if (!bg) return null;

  // Аудит 2026-08-20: `.trim()` СНАРУЖИ — заголовок из одних пробелов проходил
  // `||` как истинный и после обрезки давал пустую строку, то есть баннер без
  // заголовка. Обрезаем до проверки.
  const title = opts.title?.trim() || "Дайджест";
  // 46931a2 переименовал wrap → wrapByWidth и ввёл авто-фит, но этот вызов
  // остался на старом имени: ReferenceError на любой генерации иллюстрированного
  // баннера. Переводим на fitTitle — ту же подгонку кегля, что и в основном
  // баннере (`buildBannerSvg`), вместо жёсткой пары 96/116 без защиты от
  // обрезки.
  const { lines: titleLines, size: titleSize } = fitTitle(title, ILL_TITLE_AVAIL_W);

  // Аудит 2026-08-20: подзаголовок здесь не рисовался ВООБЩЕ. Тип его
  // принимает, схема инструмента прямо просит модель его дать («дай coverTitle
  // (+coverSubtitle)»), иллюстрированный баннер — путь по умолчанию, и текст
  // молча пропадал: ни в картинке, ни в предупреждении. Ставим его туда же,
  // куда и на чистом баннере — строкой между заголовком и датой.
  //
  // Ширина — та же ILL_TITLE_AVAIL_W, что и у заголовка: поля симметричны, а
  // логотип на этом баннере в правом верхнем углу и тексту не мешает.
  const subRaw = opts.subtitle ? dedupeSubtitleDate(opts.subtitle, opts.date) : "";
  const subtitle = subRaw ? esc(fitSubtitle(subRaw, ILL_TITLE_AVAIL_W)) : "";
  const subBlockH = subtitle ? 64 : 0;

  // Заголовок прижат к низу, внутри тёмного скрима.
  const titleBlockH = titleLines.length * titleSize * 1.1;
  const titleTopY = IH - 150 - subBlockH - titleBlockH;
  const titleTspans = titleLines
    .map(
      (ln, i) =>
        `<text x="${PADX}" y="${titleTopY + (i + 1) * titleSize * 1.05}" font-family="${FONT_DISPLAY}" font-size="${titleSize}" font-weight="800" letter-spacing="${(-(titleSize * 0.018)).toFixed(2)}" fill="#ffffff">${esc(ln)}</text>`,
    )
    .join("\n");

  const tagRaw = opts.tag || "AI × Web3";
  const tag = esc(tagRaw);
  const date = opts.date ? esc(opts.date) : "";

  const logo = logoDataUri();
  const logoR = 96;
  const logoCx = IW - 120 - logoR;
  const logoCy = 130;
  const logoSvg = logo
    ? `<clipPath id="logoClipI"><circle cx="${logoCx}" cy="${logoCy}" r="${logoR}"/></clipPath>
  <circle cx="${logoCx}" cy="${logoCy}" r="${logoR + 7}" fill="#05070f" fill-opacity="0.45"/>
  <circle cx="${logoCx}" cy="${logoCy}" r="${logoR + 6}" fill="none" stroke="#16e0c8" stroke-opacity="0.7" stroke-width="3"/>
  <image x="${logoCx - logoR}" y="${logoCy - logoR}" width="${logoR * 2}" height="${logoR * 2}" href="${logo}" clip-path="url(#logoClipI)" preserveAspectRatio="xMidYMid slice"/>`
    : "";

  const tagW = 52 + tagRaw.length * 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${IW}" height="${IH}" viewBox="0 0 ${IW} ${IH}">
  <defs>
    <linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#05070f" stop-opacity="0"/>
      <stop offset="0.55" stop-color="#05070f" stop-opacity="0.45"/>
      <stop offset="1" stop-color="#05070f" stop-opacity="0.94"/>
    </linearGradient>
    <linearGradient id="topshade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#05070f" stop-opacity="0.55"/>
      <stop offset="1" stop-color="#05070f" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <image x="0" y="0" width="${IW}" height="${IH}" href="${bg}" preserveAspectRatio="xMidYMid slice"/>
  <rect x="0" y="0" width="${IW}" height="${IH}" fill="url(#scrim)"/>
  <rect x="0" y="0" width="${IW}" height="240" fill="url(#topshade)"/>
  <rect x="${PADX}" y="86" width="${tagW}" height="60" rx="30" fill="#6d5cff" fill-opacity="0.30" stroke="#b9b2ff" stroke-opacity="0.7"/>
  <text x="${PADX + 28}" y="125" font-family="${FONT_TEXT}" font-size="32" font-weight="800" letter-spacing="1.5" fill="#ffffff">${tag}</text>
  ${logoSvg}
  <rect x="${PADX}" y="${titleTopY - 6}" width="12" height="${titleBlockH + 12}" rx="6" fill="#16e0c8"/>
  <g transform="translate(${TITLE_SHIFT_X},0)">
  ${titleTspans}
  ${subtitle ? `<text x="${PADX}" y="${IH - 168}" font-family="${FONT_TEXT}" font-size="${SUB_SIZE}" font-weight="600" fill="#c3cbe0">${subtitle}</text>` : ""}
  ${date ? `<text x="${PADX}" y="${IH - 70}" font-family="${FONT_TEXT}" font-size="40" font-weight="800" fill="#16e0c8">${date}</text>` : ""}
  </g>
</svg>`;
}

/**
 * Отрисовать иллюстрированный баннер в PNG. Рендерим через прямой Resvg (минуя
 * 200KB-гард renderSvgToPng — фон-картинка в base64 заведомо больше; это наш
 * доверенный композит, не пользовательский SVG). Возвращает null, если пул пуст.
 */
export async function renderIllustratedBannerPng(
  opts: IllustratedBannerOpts,
): Promise<Buffer | null> {
  const svg = buildIllustratedBannerSvg(opts);
  if (!svg) return null;
  return renderBrandSvgToPng(svg, IW);
}

/** Есть ли в сборке хотя бы один фон для иллюстрированного баннера. */
export function hasBannerPool(): boolean {
  return bannerPool().length > 0;
}
