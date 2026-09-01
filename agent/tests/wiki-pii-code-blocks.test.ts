/**
 * Аудит 2026-08-12: PII-фильтр вики молча портил код на страницах.
 *
 * Правило хэндла:
 *   .replace(/(^|[\s(])@([A-Za-z0-9_]{4,})/g, "$1<handle-redacted>")
 * не отличает телеграм-ник от собаки в коде. Замер до правки:
 *
 *   "```css\n@media (max-width: 600px) …"  → "```css\n<handle-redacted> (max-width…"
 *   "```ts\n@Injectable()\nexport class …" → "```ts\n<handle-redacted>()\nexport class …"
 *   "/**\n * @param x …\n * @returns …"    → "<handle-redacted> x …", "<handle-redacted> …"
 *
 * Писатель при этом получает `ok: true`: страница сохранена, ошибки нет, а
 * содержимое уже не то, что записывали. Пишут такие страницы агенты — это
 * решения и архитектура в долгой памяти команды, то есть портится ровно тот
 * слой, ради которого вики и заведена, и заметить это можно только глазами.
 *
 * Инвариант: внутри огороженного блока (```…```) и инлайн-кода (`…`) правило
 * хэндла не применяется — там собака синтаксис, а не ник. Почта и телефон
 * редактируются везде, включая код: в примере конфига они настоящие.
 * В обычном тексте всё остаётся как было — ник это ник.
 */
import { describe, test, expect } from "bun:test";
import { sanitizeWikiContent, sanitizeWikiTitle } from "../lib/memory.ts";

describe("код на странице переживает фильтр", () => {
  test("CSS at-rule в огороженном блоке", () => {
    const src = "```css\n@media (max-width: 600px) { .a { color: red } }\n```";
    expect(sanitizeWikiContent(src)).toBe(src);
  });

  test("декоратор TypeScript в огороженном блоке", () => {
    const src = "```ts\n@Injectable()\nexport class Svc {}\n```";
    expect(sanitizeWikiContent(src)).toBe(src);
  });

  test("JSDoc-теги в огороженном блоке", () => {
    const src = "```ts\n/**\n * @param x — вход\n * @returns строка\n */\n```";
    expect(sanitizeWikiContent(src)).toBe(src);
  });

  test("инлайн-код — тоже код", () => {
    // Раньше это выживало случайно: перед @ стоял бэктик, а правило требует
    // пробел, скобку или начало строки. С пробелом внутри — уже не выживало.
    const src = "Правило ` @media ` и `@Injectable` в тексте.";
    expect(sanitizeWikiContent(src)).toBe(src);
  });

  test("несколько блоков подряд, текст между ними не защищён", () => {
    const src =
      "```ts\n@Injectable()\n```\nПиши @dobropalm.\n```css\n@media all {}\n```";
    const out = sanitizeWikiContent(src);
    expect(out).toContain("@Injectable()");
    expect(out).toContain("@media all {}");
    expect(out).toContain("<handle-redacted>");
    expect(out).not.toContain("@dobropalm");
  });

  test("незакрытый блок не открывает дыру до конца файла… и не ломает вход", () => {
    // Хвост без закрывающего ``` — оставляем как код: писатель имел в виду код,
    // а не способ пронести ник. Главное — не падать и не терять текст.
    const src = "```ts\n@Injectable()\n";
    expect(() => sanitizeWikiContent(src)).not.toThrow();
    expect(sanitizeWikiContent(src)).toContain("Injectable");
  });
});

describe("ник в обычном тексте по-прежнему редактируется", () => {
  test("прозаическое упоминание", () => {
    expect(sanitizeWikiContent("Пиши владельцу @dobropalm, если что.")).toBe(
      "Пиши владельцу <handle-redacted>, если что.",
    );
  });

  test("после скобки и в начале строки", () => {
    expect(sanitizeWikiContent("(@dobropalm)")).toContain("<handle-redacted>");
    expect(sanitizeWikiContent("@dobropalm пишет")).toContain(
      "<handle-redacted>",
    );
  });

  test("заголовок чистится так же", () => {
    expect(sanitizeWikiTitle("Заметка от @dobropalm")).toContain(
      "<handle-redacted>",
    );
  });
});

describe("почта и телефон редактируются и внутри кода", () => {
  test("почта в примере конфига — всё равно настоящая", () => {
    const out = sanitizeWikiContent("```env\nOWNER=real.name@example.com\n```");
    expect(out).toContain("<email-redacted>");
    expect(out).not.toContain("example.com");
  });

  test("телефон внутри блока", () => {
    const out = sanitizeWikiContent("```\nsupport: +7 999 123-45-67\n```");
    expect(out).toContain("<phone-redacted>");
  });
});
