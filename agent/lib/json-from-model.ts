/**
 * json-from-model.ts — достать JSON-объект из текста, который написала модель.
 *
 * Зачем отдельный модуль. Один и тот же сканер «найди первый сбалансированный
 * {...}» жил в ЧЕТЫРЁХ копиях: `tools/daily-draft.ts`, `lib/fact-check.ts`,
 * `tools/site-editorial.ts` и `lib/compactor.ts`. Из-за этого починка 30.09
 * (аудит AUD-043, PR #118) закрыла ошибку ровно в одной из них, а прод
 * продолжал падать на второй. Пока копий больше одной, следующая починка снова
 * окажется частичной — поэтому копии запрещены тестом, а не уговором.
 *
 * Симптом у каждой копии свой, и это же мешало их связать: у черновика дня —
 * падение юнита, у фактчекера — «проверка не состоялась» (то есть снятая
 * статья), у компактора — молча потерянное сжатие (кандидат не распарсился,
 * разбор ушёл в жадный откат).
 *
 * Что именно ломалось. Юнит `delabs-daily-draft` падал с
 * `research failed: JSON Parse error: Unterminated string` (29.09 08:03 UTC).
 * Сообщение уводит в сторону: звучит как обрыв ответа по лимиту или таймауту.
 * На деле скобки сбалансированы, кавычки закрыты, а запрещён ровно один байт —
 * НАСТОЯЩИЙ перевод строки внутри JSON-строки. JSON не допускает сырых
 * управляющих символов, и `JSON.parse` называет это «Unterminated string».
 * Промпт просил `body` из нескольких абзацев, и абзацы модель разделила
 * переводом строки, а не `\n`. Ждать от модели идеального экранирования смысла
 * нет — черновик дня терялся целиком из-за одного байта.
 *
 * Поэтому сканер, который и так знает про каждый символ, внутри строки он или
 * нет, по пути экранирует сырые управляющие символы. Для корректного JSON это
 * операция тождественная: там таких символов внутри строк не бывает по
 * определению. Настоящий обрыв ответа зелёным НЕ становится — у него не
 * сходятся скобки, и он возвращает `unbalanced`.
 *
 * Сообщения об ошибках сознательно оставлены вызывающей стороне: у фактчекера
 * они по-русски, у черновика дня по-английски, и оба набора закреплены тестами.
 * Модуль возвращает результат, а не бросает, чтобы не связывать их между собой.
 */

/** Результат поиска: либо готовый к разбору JSON-текст, либо причина отказа. */
export type JsonSliceResult =
  | { ok: true; json: string }
  | { ok: false; reason: "no-object" | "unbalanced" };

/**
 * Единственный проход по символам. Остальные функции модуля — обёртки над ним,
 * чтобы рукописных сканеров в дереве больше не было (это закреплено тестом
 * `audit-2026-09-30-json-from-model-single-scanner`).
 *
 * Возвращает индекс закрывающей `}` и — если просили — санитизированный срез.
 */
function scan(text: string, start: number, collect: boolean): { end: number; json?: string } {
  let depth = 0;
  let inStr = false;
  let esc = false;
  const out: string[] | null = collect ? [] : null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      out?.push(escapeInString(ch));
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    out?.push(ch);
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { end: i, json: out ? out.join("") : undefined };
    }
  }
  return { end: -1 };
}

/**
 * Индекс `}`, закрывающей объект, который начинается в `start` (там стоит `{`),
 * либо -1. Строки учитываются: `{"line":"a } b"}` не закрывается на скобке
 * внутри строки, а `\"` внутри строки её не закрывает.
 */
export function matchBraceEnd(text: string, start: number): number {
  return scan(String(text ?? ""), start, false).end;
}

/**
 * Санитизированный срез объекта, начинающегося в `start`. Нужен там, где
 * кандидатов несколько и перебираются все открывающие скобки (см. compactor).
 */
export function balancedJsonSliceAt(text: string, start: number): JsonSliceResult {
  const r = scan(String(text ?? ""), start, true);
  if (r.end < 0 || r.json === undefined) return { ok: false, reason: "unbalanced" };
  return { ok: true, json: r.json };
}

/**
 * Найти ПЕРВЫЙ сбалансированный `{...}` и вернуть его как КОРРЕКТНЫЙ JSON-текст,
 * пригодный для `JSON.parse`: сырые управляющие символы внутри строк по пути
 * экранированы.
 */
export function balancedJsonSlice(raw: string): JsonSliceResult {
  const text = String(raw ?? "");
  const start = text.indexOf("{");
  if (start < 0) return { ok: false, reason: "no-object" };
  return balancedJsonSliceAt(text, start);
}

/**
 * Один символ внутри JSON-строки → то, что допустимо внутри JSON-строки.
 * Всё, что ниже 0x20, JSON требует экранировать; у четырёх символов есть
 * короткая запись, остальные уходят в `\uXXXX`. Прочие символы — как есть.
 */
function escapeInString(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code >= 0x20) return ch;
  const short: Record<string, string> = {
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\b": "\\b",
    "\f": "\\f",
  };
  return short[ch] ?? `\\u${code.toString(16).padStart(4, "0")}`;
}
