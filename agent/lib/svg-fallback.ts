/**
 * T-514: SVG fallback for GENERATE_IMAGE.
 *
 * Когда OpenAI image API возвращает 429 / insufficient_quota / billing_hard_limit_reached,
 * мы не падаем молча — а просим Claude (haiku) сгенерировать аналогичную картинку
 * как SVG markup, который потом рендерим в PNG через существующий svg-render
 * и отправляем через tgSendPhoto. Полная цепочка идентична GENERATE_SVG_IMAGE,
 * просто SVG markup приходит из Claude вместо ручного payload агента.
 *
 * Используется только из action-dispatch.ts GENERATE_IMAGE handler.
 */
import { getErrorMessage } from "./errors.ts";
import type Anthropic from "@anthropic-ai/sdk";
import { callAnthropic } from "./anthropic-client.ts";
import { shouldUseSubscription } from "./subscription-env.ts";

/**
 * Эвристика: похоже ли это на квоту/билинг OpenAI, после которой имеет смысл
 * fallback'нуть в SVG, а не пытаться ретраить?
 *
 * Срабатываем на:
 *  - 429 от OpenAI (rate-limit / quota_exceeded)
 *  - `insufficient_quota`
 *  - `billing_hard_limit_reached`
 *  - `billing_not_active`
 */
export function isOpenAIQuotaError(err: unknown): boolean {
  const msg = getErrorMessage(err);
  if (!msg) return false;
  const low = msg.toLowerCase();
  // Статус 429 сам по себе не идентифицирует вендора: его возвращает и
  // Telegram при flood control. `generateImage` добавляет один из этих
  // маркеров в собственную ошибку, поэтому fallback не должен запускаться по
  // чужому ограничению.
  const openAI429 =
    /\b429\b/.test(low) &&
    (low.includes("openai image api error") ||
      low.includes("api.openai.com") ||
      low.includes("quota"));
  return (
    openAI429 ||
    low.includes("insufficient_quota") ||
    low.includes("billing_hard_limit_reached") ||
    low.includes("billing_not_active") ||
    low.includes("quota_exceeded")
  );
}

const SYSTEM_PROMPT = `You are an SVG illustrator. Given a short visual description, produce a single self-contained inline SVG (no external assets, no <image> tags, no scripts) that best illustrates it.

Rules:
- Output ONLY raw <svg>...</svg> — no markdown fences, no commentary, no <!DOCTYPE>.
- Use viewBox="0 0 1024 1024" and width/height of 1024.
- Allowed: <rect>, <circle>, <ellipse>, <line>, <polyline>, <polygon>, <path>, <g>, <defs>, <linearGradient>, <radialGradient>, <stop>, <text>, <tspan>, <title>, <desc>.
- Prefer flat colors, simple gradients, geometric shapes; avoid raster fills.
- Avoid more than ~80 elements total — must render fast.
- No JavaScript, no <foreignObject>, no external fonts (system font-family only).`;

/**
 * Сгенерировать SVG markup по короткому prompt'у.
 * Возвращает строку с `<svg ...>...</svg>`. Бросает Error если Claude не вернул
 * валидный SVG.
 */
export async function generateSvgFromPrompt(
  prompt: string,
  agentKey: string,
  override?: Anthropic | null,
): Promise<string> {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("prompt is empty");
  if (trimmed.length > 4000) throw new Error("prompt too long (>4000 chars)");

  let text: string;
  if (shouldUseSubscription()) {
    // Dynamic import avoids the existing tools-schema → media → svg-fallback
    // cycle: agent-sdk-runtime imports tools-schema to build MCP tools.
    const { runTextViaAgentSdk } = await import("./agent-sdk-runtime.ts");
    text = await runTextViaAgentSdk({
      system: SYSTEM_PROMPT,
      prompt: trimmed,
      maxTurns: 1,
      model: process.env.ANTHROPIC_SMALL_MODEL_SDK?.trim() || "haiku",
      agentKey: `${agentKey}:svg-fallback`,
    });
  } else {
    const completion = await callAnthropic(
      {
        model: process.env.ANTHROPIC_SMALL_MODEL?.trim() || "claude-haiku-4-5-20251001",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: trimmed }],
      },
      override,
      `${agentKey}:svg-fallback`,
    );

    text = completion.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  }

  const svg = extractSvg(text);
  if (!svg) {
    throw new Error("svg-fallback: Claude response did not contain <svg>...</svg>");
  }
  return svg;
}

/** Индекс сразу за `>` тега, начинающегося на `i`, с учётом кавычек в атрибутах. */
function tagEnd(s: string, i: number): number {
  let quote: string | null = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ">") return j + 1;
  }
  return -1;
}

/** `<svg` на позиции `i` — именно тег, а не начало слова вроде `<svgfoo`. */
function isOpenAt(low: string, i: number): boolean {
  if (!low.startsWith("<svg", i)) return false;
  const c = low[i + 4];
  return c !== undefined && /[\s/>]/.test(c);
}

function isCloseAt(low: string, i: number): boolean {
  if (!low.startsWith("</svg", i)) return false;
  const c = low[i + 5];
  return c !== undefined && /[\s>]/.test(c);
}

/**
 * Индекс сразу за `</svg>`, парным открывающему тегу на позиции `start`.
 * -1, если пара не нашлась. Вложенный `<svg>` внутри SVG легален, поэтому
 * считаем глубину, а не ищем первое или последнее вхождение.
 */
function matchingClose(low: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < low.length) {
    if (low.startsWith("<!--", i)) {
      const e = low.indexOf("-->", i + 4);
      i = e === -1 ? low.length : e + 3;
      continue;
    }
    if (low.startsWith("<![cdata[", i)) {
      const e = low.indexOf("]]>", i + 9);
      i = e === -1 ? low.length : e + 3;
      continue;
    }
    if (isCloseAt(low, i)) {
      const end = tagEnd(low, i);
      if (end === -1) return -1;
      depth--;
      if (depth === 0) return end;
      i = end;
      continue;
    }
    if (isOpenAt(low, i)) {
      const end = tagEnd(low, i);
      if (end === -1) return -1;
      if (low[end - 2] === "/") {
        // `<svg ... />` — элемент закрыт сразу, глубину не меняет.
        if (i === start) return end;
      } else {
        depth++;
      }
      i = end;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * Нижний регистр только для ASCII — и это принципиально, а не оптимизация.
 *
 * Аудит 2026-08-28: индексы ищутся в `low`, а режется `text`, поэтому
 * приведение обязано сохранять длину. `String.prototype.toLowerCase` её не
 * сохраняет: `"İ".toLowerCase()` — это `i` плюс комбинирующая точка, два
 * символа вместо одного. Один такой символ в преамбуле сдвигал рез вправо, и
 * у документа отгрызался `<`; вызывающий код непустую строку считает успехом,
 * так что наружу выходило поломанное SVG, а не ошибка. Сканеру нужны только
 * ASCII-последовательности (`<svg`, `</svg`, `<![cdata[`), так что ограничение
 * A-Z ничего не теряет.
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * Сколько ХОЛОСТЫХ кандидатов `<svg` перебирать, прежде чем сдаться.
 *
 * Аудит 2026-08-29: цикл ниже квадратичен по длине текста. Кандидат без пары
 * стоит скана до конца строки (`matchingClose`), после чего `from` сдвигается
 * на 4 символа и всё повторяется. Замер синхронного вызова на
 * `"<svg ".repeat(n)`: 16 КБ — 57 мс, 64 КБ — 824 мс, 200 КБ — 8008 мс. Всё
 * это время стоит единственный поток, на котором живут и 12 ботов, и
 * HTTP-сервер Mini App.
 *
 * Вход сюда — текст модели, то есть управляемый prompt-injection'ом; сегодня
 * он ограничен ЧУЖОЙ настройкой (`max_tokens: 4000` у вызова выше, ~16 КБ),
 * а сама экспортируемая функция потолка не имеет. Ограничиваем не длину
 * входа (обрезать валидный документ хуже, чем его не найти), а число
 * неудачных попыток: у нормального ответа кандидат один и он же удачный, так
 * что до счётчика дело не доходит. Работа становится линейной.
 *
 * Ранний выход «первый не закрылся — значит и остальные» был бы неверен:
 * `<svg><svg></svg>` закрывается со второго кандидата, а не с первого.
 */
const MAX_SVG_CANDIDATES = 16;

/**
 * Вытащить `<svg>...</svg>` из ответа Claude. Терпим к markdown-фенсам и к
 * комментариям вокруг: режем ровно по границам элемента, поэтому фенсы,
 * преамбула и послесловие отпадают сами.
 *
 * Аудит 2026-08-20: раньше брали `indexOf("<svg")` и `lastIndexOf("</svg>")` —
 * первое вхождение и последнее. Оба конца ломались независимо:
 *
 *   • преамбула, упоминающая тег («сейчас будет `<svg>` на 1200×630»), давала
 *     старт на упоминании, и в результат уезжал текст с фенсом внутри;
 *   • два рисунка в ответе склеивались в один кусок — открывающий тег первого,
 *     закрывающий второго, между ними проза и лишний корень.
 *
 * И то и другое даёт документ, который resvg не разбирает, — а вызывающий код
 * считает непустую строку успехом. Теперь ищем ПАРНЫЙ закрывающий тег со
 * счётчиком глубины и, если у кандидата пары нет, пробуем следующее вхождение
 * `<svg`. Упоминание в прозе так отсеивается само: пары у него не будет.
 */
export function extractSvg(text: string): string | null {
  if (!text) return null;
  const low = asciiLower(text);
  let from = 0;
  let tried = 0;
  while (from < low.length) {
    let start = -1;
    for (let i = from; i < low.length; i++) {
      if (isOpenAt(low, i)) {
        start = i;
        break;
      }
    }
    if (start === -1) return null;
    const end = matchingClose(low, start);
    if (end !== -1) return text.slice(start, end);
    if (++tried >= MAX_SVG_CANDIDATES) return null;
    from = start + 4;
  }
  return null;
}
