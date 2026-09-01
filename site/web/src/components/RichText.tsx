import type { ComponentChildren } from "preact";
import { safeHref } from "../format";

/**
 * Безопасный inline-рендер нашего «лёгкого markdown»: `**жирный**` и
 * `[текст](url)`. XSS-безопасно по построению — никакого innerHTML, только
 * JSX-узлы (Preact экранирует текстовые ноды). Ссылки проходят через safeHref:
 * не-http(s) url не получает href, показывается только текст ссылки.
 */

// Один токен: либо ссылка `[t](url)`, либо жирный `**x**`. Глобальный, чтобы
// идти по строке сегментами через matchAll.
const TOKEN_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*/g;

/** Inline-рендер строки в массив Preact-узлов (без абзацев). */
export function renderRichInline(text: string): ComponentChildren[] {
  const nodes: ComponentChildren[] = [];
  let last = 0;
  let key = 0;
  // matchAll по свежему regex-стейту: TOKEN_RE глобальный, но lastIndex
  // сбрасывается каждым новым matchAll, так что вызовы независимы.
  for (const m of text.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push(text.slice(last, idx));
    if (m[1] !== undefined && m[2] !== undefined) {
      // Ссылка: [текст](url)
      const linkText = m[1];
      const href = safeHref(m[2]);
      if (href) {
        nodes.push(
          <a
            key={key++}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkText}
          </a>,
        );
      } else {
        // url не прошёл allowlist — показываем только текст, без битого href.
        nodes.push(linkText);
      }
    } else if (m[3] !== undefined) {
      // Жирный: **x**
      nodes.push(<strong key={key++}>{m[3]}</strong>);
    }
    last = idx + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * Блочный рендер: разбивает текст по пустым строкам на абзацы `<p>`, внутри
 * каждого — inline (жирный + ссылки). Для intro / «что такое» / body дайджеста.
 */
export function renderRichBlock(text: string): ComponentChildren {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (paragraphs.length === 0) return null;
  return paragraphs.map((p, i) => <p key={i}>{renderRichInline(p)}</p>);
}
