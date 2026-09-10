/**
 * SVG Template Library — fallback для GENERATE_SVG_IMAGE когда OpenAI billing limit hit
 * 
 * Context: T-260 — расширить SVG fallback после T-102 (OpenAI billing восстановлен, но SVG остается резервом)
 * 
 * Структура:
 * - Набор семантически организованных SVG-шаблонов с placeholder'ами {{VARIABLE}}
 * - Маппинг ключевых слов на подходящие шаблоны
 * - Функция замены placeholder'ов на реальные значения
 *
 * Аудит 2026-08-11: модуль НИ ОТКУДА не вызывается. T-260 закрыт как сделанный,
 * заметка `.claude/memory/notes/role-design/svg-template-library.md` описывает
 * библиотеку как поставленную, но проводки не случилось: живой SVG-фолбэк — это
 * `lib/svg-fallback.ts` (Claude пишет SVG по промпту), а промпт дизайнера про
 * шаблоны не знает. Оставлено как есть (шаблоны — готовая дизайнерская работа),
 * но дефекты подстановки починены — иначе они ждали бы того, кто это проводит.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { escapeXml } from "../svg-render.ts";

/** Ключи в `data` — тоже вход: без этого они попадали прямо в тело RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface SvgTemplate {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  filePath: string;
  placeholders: string[];
}

export interface TemplateData {
  [placeholder: string]: string;
}

const TEMPLATES_DIR = join(__dirname, "svg-templates");

export const SVG_TEMPLATES: readonly SvgTemplate[] = [
  {
    id: "announcement",
    name: "Announcement Card",
    description: "Formal announcement or notification card with title, subtitle and content areas",
    keywords: ["announcement", "notice", "notification", "alert", "news", "update", "release", "launch"],
    filePath: join(TEMPLATES_DIR, "announcement.svg"),
    placeholders: ["TITLE", "SUBTITLE", "CONTENT_LINE_1", "CONTENT_LINE_2", "CONTENT_LINE_3"]
  },
  {
    id: "infographic",
    name: "Data Infographic",
    description: "Statistics and data presentation with charts, metrics and content blocks",
    keywords: ["infographic", "statistics", "data", "metrics", "stats", "numbers", "analytics", "report"],
    filePath: join(TEMPLATES_DIR, "infographic.svg"),
    placeholders: ["TITLE", "SUBTITLE", "STAT_1", "LABEL_1", "STAT_2", "LABEL_2", "STAT_3", "LABEL_3", "CHART_TITLE", "CONTENT_TITLE", "CONTENT_LINE_1", "CONTENT_LINE_2", "CONTENT_LINE_3", "CONTENT_LINE_4", "CONTENT_LINE_5"]
  },
  {
    id: "banner",
    name: "Marketing Banner",
    description: "Promotional banner with call-to-action, perfect for campaigns and marketing",
    keywords: ["banner", "promotion", "marketing", "campaign", "cta", "call to action", "promo", "advertisement", "offer"],
    filePath: join(TEMPLATES_DIR, "banner.svg"),
    placeholders: ["TITLE", "SUBTITLE", "CTA_BUTTON", "DESCRIPTION_LINE_1", "DESCRIPTION_LINE_2", "DESCRIPTION_LINE_3", "ICON_TEXT"]
  },
  {
    id: "status-dashboard",
    name: "Status Dashboard",
    description: "System status and monitoring dashboard with service indicators and metrics",
    keywords: ["status", "dashboard", "monitoring", "system", "health", "uptime", "services", "ops", "devops"],
    filePath: join(TEMPLATES_DIR, "status-dashboard.svg"),
    placeholders: ["TITLE", "TIMESTAMP", "SERVICE_1", "STATUS_1_COLOR", "STATUS_1_TEXT", "METRIC_1", "VALUE_1", "SERVICE_2", "STATUS_2_COLOR", "STATUS_2_TEXT", "METRIC_2", "VALUE_2", "SERVICE_3", "STATUS_3_COLOR", "STATUS_3_TEXT", "METRIC_3", "VALUE_3", "METRICS_TITLE", "LEGEND_ITEM_1", "LEGEND_ITEM_2", "LEGEND_ITEM_3"]
  },
  {
    id: "ui-mockup",
    name: "Mobile UI Mockup",
    description: "Mobile app interface mockup with navigation, cards and buttons",
    keywords: ["ui", "mockup", "mobile", "app", "interface", "screen", "wireframe", "prototype", "design"],
    filePath: join(TEMPLATES_DIR, "ui-mockup.svg"),
    placeholders: ["APP_NAME", "HEADER_TITLE", "HEADER_SUBTITLE", "TAB_1", "TAB_2", "TAB_3", "CARD_1_TITLE", "CARD_1_CONTENT", "CARD_1_META", "CARD_2_TITLE", "CARD_2_CONTENT", "CARD_2_META", "CARD_3_TITLE", "CARD_3_CONTENT", "CARD_3_META", "BUTTON_1", "BUTTON_2"]
  },
  {
    id: "social-post",
    name: "Social Media Post",
    description: "Social media post template with content areas, hashtags and branding",
    keywords: ["social", "post", "social media", "instagram", "facebook", "twitter", "content", "hashtags", "brand"],
    filePath: join(TEMPLATES_DIR, "social-post.svg"),
    placeholders: ["TITLE", "SUBTITLE", "DATE", "CONTENT_HEADER", "CONTENT_LINE_1", "CONTENT_LINE_2", "CONTENT_LINE_3", "HIGHLIGHT_TITLE", "HIGHLIGHT_CONTENT", "CTA_TEXT", "HASHTAG_1", "HASHTAG_2", "HASHTAG_3", "BRAND_INITIAL", "BRAND_NAME"]
  },
  {
    id: "presentation-slide",
    name: "Presentation Slide",
    description: "Professional presentation slide with bullet points, charts and takeaways",
    keywords: ["presentation", "slide", "deck", "powerpoint", "meeting", "business", "corporate", "pitch"],
    filePath: join(TEMPLATES_DIR, "presentation-slide.svg"),
    placeholders: ["SLIDE_TITLE", "SLIDE_SUBTITLE", "POINT_1_TITLE", "POINT_1_DESCRIPTION", "POINT_2_TITLE", "POINT_2_DESCRIPTION", "POINT_3_TITLE", "POINT_3_DESCRIPTION", "POINT_4_TITLE", "POINT_4_DESCRIPTION", "TAKEAWAY_TITLE", "TAKEAWAY_CONTENT", "TAKEAWAY_DETAIL", "CHART_TITLE", "LEGEND_1", "PERCENT_1", "LEGEND_2", "PERCENT_2", "LEGEND_3", "PERCENT_3", "LEGEND_4", "PERCENT_4", "FOOTER_TEXT", "SLIDE_NUMBER"]
  },
  {
    id: "error-illustration",
    name: "Error Illustration",
    description: "Error state illustration with error code, description and action button",
    keywords: ["error", "404", "500", "failure", "problem", "issue", "bug", "exception", "crash"],
    filePath: join(TEMPLATES_DIR, "error-illustration.svg"),
    placeholders: ["ERROR_TITLE", "ERROR_SUBTITLE", "ERROR_CODE", "ERROR_DESCRIPTION", "ERROR_SUGGESTION", "ACTION_BUTTON"]
  },
  {
    id: "simple-chart",
    name: "Simple Chart",
    description: "Basic bar chart with data visualization, labels and legend",
    keywords: ["chart", "graph", "bar chart", "visualization", "comparison"],
    filePath: join(TEMPLATES_DIR, "simple-chart.svg"),
    placeholders: ["CHART_TITLE", "CHART_SUBTITLE", "Y_LABEL_1", "Y_LABEL_2", "Y_LABEL_3", "Y_LABEL_4", "X_LABEL_1", "X_LABEL_2", "X_LABEL_3", "X_LABEL_4", "X_LABEL_5", "X_LABEL_6", "VALUE_1", "VALUE_2", "VALUE_3", "VALUE_4", "VALUE_5", "VALUE_6", "LEGEND_TITLE", "SERIES_1", "SERIES_2"]
  }
];

/**
 * Ключевое слово как регулярка: по границе слова и с необязательным
 * множественным числом.
 *
 * Аудит 2026-09-10: сравнение было `request.toLowerCase().includes(keyword)`,
 * то есть подстрокой в любом месте любого слова. Ключ `app` (ui-mockup) сидит
 * внутри `happy`, `apple` и `approve`, `ops` — внутри `develops`, `post` —
 * внутри `postpone`. Запрос «happy new year post» выбирал ui-mockup: `app`
 * нашёлся в `happy`, а ui-mockup стоит в списке раньше social-post. Граница
 * слова это убирает, `(?:e?s)?` сохраняет прежнее попадание во множественное
 * число («charts», «services»), ради которого подстрока и годилась.
 *
 * Границы описаны через `\p{L}\p{N}`, а не `\b`: `\b` определён по `\w`
 * (латиница), и рядом с кириллицей вёл бы себя не так, как здесь нужно.
 */
function keywordPattern(keyword: string): RegExp {
  const body = keyword.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${body}(?:e?s)?(?![\\p{L}\\p{N}])`,
    "iu",
  );
}

/** Регулярки собираются один раз: их под семьдесят, а `selectTemplate` зовут на каждый запрос. */
const TEMPLATE_MATCHERS: ReadonlyArray<{
  template: SvgTemplate;
  patterns: readonly RegExp[];
}> = SVG_TEMPLATES.map((template) => ({
  template,
  patterns: template.keywords.map(keywordPattern),
}));

/**
 * Выбрать подходящий шаблон по семантике запроса.
 *
 * Первое совпадение выигрывает, поэтому порядок `SVG_TEMPLATES` — это правило,
 * а не оформление. Аудит 2026-09-10: пять ключей были записаны сразу двум
 * шаблонам, и второй из пары не выбирался НИКОГДА:
 *
 *   dashboard, metrics  — infographic перекрывал status-dashboard
 *   data, analytics, statistics — infographic перекрывал simple-chart
 *
 * То есть запрос «нарисуй dashboard» приносил инфографику, а не дашборд, при
 * живом шаблоне `status-dashboard.svg`. Ключи разведены по одному владельцу:
 * `dashboard` ушёл к status-dashboard (там он в самом имени), остальные
 * четыре закреплены за infographic — за тем, кто их и так выигрывал, так что
 * поведение по ним не изменилось. Непересечение держит тест
 * `audit-2026-09-10-svg-template-keywords`.
 */
export function selectTemplate(request: string): SvgTemplate {
  for (const { template, patterns } of TEMPLATE_MATCHERS) {
    if (patterns.some((re) => re.test(request))) return template;
  }

  // Fallback: если ничего не нашли, возвращаем первый шаблон (announcement)
  return SVG_TEMPLATES[0]!;
}

/**
 * Загрузить и заполнить шаблон данными
 */
export function renderTemplate(template: SvgTemplate, data: TemplateData): string {
  let svgContent: string;
  
  try {
    svgContent = readFileSync(template.filePath, "utf-8");
  } catch (error) {
    throw new Error(`Failed to read template ${template.id}: ${error}`);
  }
  
  // Заменяем все placeholder'ы.
  //
  // Аудит 2026-08-11 — две правки в трёх строках:
  //
  //  1. `escapeXml`. Значения приходят от модели (generateSvgFromRequest кладёт
  //     в CONTENT_LINE_1 сам текст запроса), а подставлялись сырыми. Текст с `&`
  //     или `<` давал невалидный XML — resvg отвечал «malformed entity
  //     reference», картинка не приходила вообще. Текст с `</text><rect …/>`
  //     дописывал в SVG свои узлы, а с кавычкой — выходил из атрибута
  //     (плейсхолдеры стоят и в атрибутах: `fill="{{STATUS_1_COLOR}}"`).
  //
  //  2. Функция вместо строки во втором аргументе `replace`. Строка-замена
  //     трактует `$&`, `` $` `` и `$'` как шаблон подстановки: значение со
  //     знаком доллара и апострофом («цена: $'») вставляло на место
  //     плейсхолдера ВЕСЬ остаток SVG-файла. Функция такие последовательности
  //     не читает.
  //
  // Экранирование общее с cover-banner.ts — см. lib/svg-render.ts.
  let result = svgContent;
  for (const [placeholder, value] of Object.entries(data)) {
    const pattern = new RegExp(`\\{\\{${escapeRegExp(placeholder)}\\}\\}`, "g");
    const safe = escapeXml(value || "");
    result = result.replace(pattern, () => safe);
  }
  
  // Убираем незаполненные placeholder'ы (заменяем на пустую строку)
  result = result.replace(/\{\{[A-Z_0-9]+\}\}/g, "");
  
  return result;
}

/**
 * Получить список всех доступных шаблонов с описанием
 */
export function getTemplateList(): Array<{ id: string; name: string; description: string; keywords: string[] }> {
  return SVG_TEMPLATES.map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    keywords: t.keywords
  }));
}

/**
 * Получить информацию о шаблоне по ID
 */
export function getTemplate(id: string): SvgTemplate | null {
  return SVG_TEMPLATES.find(t => t.id === id) || null;
}

/**
 * Автоматически создать SVG по запросу (выбор шаблона + базовое заполнение)
 */
export function generateSvgFromRequest(request: string, customData: Partial<TemplateData> = {}): { svg: string; templateUsed: string } {
  const template = selectTemplate(request);
  
  // Базовое заполнение на основе request'а
  const baseData: TemplateData = {
    TITLE: extractTitle(request) || "Generated Content",
    SUBTITLE: "Auto-generated from request",
    CONTENT_LINE_1: request,
    ...customData
  };
  
  const svg = renderTemplate(template, baseData);
  
  return {
    svg,
    templateUsed: template.id
  };
}

/**
 * Простая эвристика для извлечения заголовка из запроса
 */
function extractTitle(request: string): string {
  // Ищем заголовок в начале строки до первой точки или переноса
  const match = request.match(/^([^.!?\n]{1,60})/);
  if (match) {
    return match[1].trim();
  }
  
  // Если не нашли, берем первые несколько слов
  const words = request.split(/\s+/).slice(0, 4);
  return words.join(" ");
}
