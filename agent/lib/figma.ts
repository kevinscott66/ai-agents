/**
 * T-717: Figma REST API клиент для designer-бота.
 *
 * Токен читается лениво из env FIGMA_TOKEN (на VPS в /opt/agent-team/.env).
 * Возвращаем КОМПАКТНУЮ сводку файла (страницы → top-level фреймы/компоненты +
 * счётчики стилей), а не полное дерево документа (оно бывает в мегабайты).
 *
 * Аудит 2026-08-20: «компактная» была компактной только на одном уровне из трёх.
 * `maxPerList` резал список фреймов ВНУТРИ страницы, но число страниц и длину
 * каждого имени не ограничивал ничто. Файл на 400 страниц с именами по 400
 * символов даёт сводку ~4.2 MB — она проходит `MAX_RESPONSE_BYTES` (5 MB) и
 * уезжает в контекст модели целиком: `fmt()` в tools-schema.ts — это голый
 * JSON.stringify, а tool-loop кладёт результат в toolResults без обрезки.
 * Это ~1 млн токенов одним tool_result, то есть гарантированный обвал хода
 * роли; файл поменьше просто съедает бюджет итерации (CLAUDE.md §3.4).
 * Ссылку на файл даёт кто угодно в чате — это штатный вход тула.
 * Соседний github.ts тот же класс закрывает slice'ами на всех уровнях.
 */
import { fetchJson } from "./http.ts";

const FIGMA_API = "https://api.figma.com/v1";
const MAX_RESPONSE_BYTES = 5_000_000; // 5 MB cap on the Figma JSON response
/** Потолок на число страниц в сводке. */
const MAX_PAGES = 40;
/** Потолок на длину любого имени, пришедшего из Figma. */
const MAX_NAME_CHARS = 120;

/** Обрезать внешнюю строку до потолка (без многоточия — имя и так усечённое). */
function clip(s: string, n = MAX_NAME_CHARS): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** Извлечь fileKey из ссылки Figma или вернуть как есть, если это уже key. */
export function parseFigmaKey(urlOrKey: string): string | null {
  const s = (urlOrKey ?? "").trim();
  if (!s) return null;
  // https://www.figma.com/file/KEY/... или /design/KEY/...
  const m = s.match(/figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/);
  if (m) return m[1];
  // Голый key (буквы/цифры, разумная длина).
  if (/^[A-Za-z0-9]{10,60}$/.test(s)) return s;
  return null;
}

interface FigmaNode {
  name?: string;
  type?: string;
  children?: FigmaNode[];
}

export interface FigmaSummary {
  name: string;
  lastModified?: string;
  pageCount: number;
  styleCount: number;
  componentCount: number;
  pages: Array<{ name: string; frames: string[]; components: string[] }>;
  /** true, если страниц было больше MAX_PAGES и список усечён. */
  pagesTruncated?: boolean;
}

/** Чистая функция: из JSON-ответа Figma собрать компактную сводку (тестируемо). */
export function summarizeFigmaFile(
  doc: {
    name?: string;
    lastModified?: string;
    document?: FigmaNode;
    styles?: Record<string, unknown>;
    components?: Record<string, unknown>;
  },
  maxPerList = 25,
): FigmaSummary {
  const allPages = (doc.document?.children ?? []).filter(
    (n) => n.type === "CANVAS",
  );
  // pageCount остаётся честным числом страниц в файле, а список — усечённым.
  const pages = allPages.slice(0, MAX_PAGES);
  return {
    name: clip(doc.name ?? "(без имени)"),
    lastModified: doc.lastModified,
    pageCount: allPages.length,
    styleCount: Object.keys(doc.styles ?? {}).length,
    componentCount: Object.keys(doc.components ?? {}).length,
    pages: pages.map((p) => {
      const kids = p.children ?? [];
      return {
        name: clip(p.name ?? "(страница)"),
        frames: kids
          .filter((c) => c.type === "FRAME" || c.type === "SECTION")
          .map((c) => clip(c.name ?? ""))
          .filter(Boolean)
          .slice(0, maxPerList),
        components: kids
          .filter((c) => c.type === "COMPONENT" || c.type === "COMPONENT_SET")
          .map((c) => clip(c.name ?? ""))
          .filter(Boolean)
          .slice(0, maxPerList),
      };
    }),
    ...(allPages.length > MAX_PAGES ? { pagesTruncated: true } : {}),
  };
}

export function figmaConfigured(): boolean {
  return !!process.env.FIGMA_TOKEN;
}

/** Скачать файл и вернуть сводку. Бросает Error с понятным текстом. */
export async function fetchFigmaSummary(key: string): Promise<FigmaSummary> {
  const token = process.env.FIGMA_TOKEN;
  if (!token) throw new Error("FIGMA_TOKEN is not set");
  // depth=2 ограничивает дерево: страницы + их прямые дети (фреймы/компоненты).
  // fetchJson централизует timeout + size-cap (SEC-audit).
  const json = await fetchJson<Parameters<typeof summarizeFigmaFile>[0]>(
    `${FIGMA_API}/files/${encodeURIComponent(key)}?depth=2`,
    {
      label: "figma",
      headers: { "X-Figma-Token": token },
      maxBytes: MAX_RESPONSE_BYTES,
    },
  );
  return summarizeFigmaFile(json);
}
