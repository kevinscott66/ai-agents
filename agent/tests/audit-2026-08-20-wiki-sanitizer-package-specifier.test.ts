// Аудит 2026-08-20: PII-фильтр вики принимал спецификатор пакета за почту.
//
// Регулярка почты — `[\w.+-]+@[\w-]+\.[\w.-]+` — не проверяла TLD вообще,
// поэтому `bun@1.1.30` разбирался как «локальная часть `bun`, домен `1`,
// TLD `1.30`». Замер до правки, чистым `sanitizeWikiContent`:
//
//   "Пин версии: bun@1.1.30 и hono@4.6.5"
//     -> "Пин версии: <email-redacted> и <email-redacted>"
//   "```\nbun add hono@4.6.5\n```"
//     -> "```\nbun add <email-redacted>\n```"
//
// Почта режется ДО разбиения на код/не-код (решение аудита 2026-08-12: в
// примере конфига почта настоящая), так что фенсы не спасали. Писатель при
// этом получал ok:true — страница сохранена, ошибки нет, команда пишет всё
// в живую сессию по испорченной версии.
//
// Дискриминатор: у настоящего TLD последняя метка — буквы, минимум две.
// У semver-хвоста она числовая. Решение 2026-08-12 про код не трогается.
import { test, expect, describe } from "bun:test";
import { sanitizeWikiContent, sanitizeWikiTitle } from "../lib/memory.ts";

describe("аудит 2026-08-20: спецификатор пакета — не почта", () => {
  test("версии пакетов в тексте выживают", () => {
    const out = sanitizeWikiContent("Пин версии: bun@1.1.30 и hono@4.6.5");
    expect(out).toBe("Пин версии: bun@1.1.30 и hono@4.6.5");
  });

  test("версия внутри фенса выживает", () => {
    const out = sanitizeWikiContent("```\nbun add hono@4.6.5\n```");
    expect(out).toContain("hono@4.6.5");
    expect(out).not.toContain("<email-redacted>");
  });

  test("версия в инлайн-коде выживает", () => {
    expect(sanitizeWikiContent("`bun@1.1.30`")).toBe("`bun@1.1.30`");
  });

  test("двузначный минорный хвост тоже не почта", () => {
    // `preact@10.19.3`: домен `10`, «TLD» `19.3` — ровно тот же разбор.
    expect(sanitizeWikiContent("preact@10.19.3")).toBe("preact@10.19.3");
  });

  test("npm-range с однобуквенным хвостом — тоже не почта", () => {
    // `hono@4.x`: домен `4`, «TLD» `x`. Однобуквенных TLD не существует,
    // поэтому порог в две буквы здесь и стоит.
    expect(sanitizeWikiContent("bun add hono@4.x")).toBe("bun add hono@4.x");
  });

  // --- контроль: то, ради чего фильтр существует, не ослаблено ---

  test("настоящая почта по-прежнему режется", () => {
    const out = sanitizeWikiContent("пиши на foo.bar+baz@example.com please");
    expect(out).toContain("<email-redacted>");
    expect(out).not.toContain("foo.bar+baz@example.com");
  });

  test("почта в примере конфига режется и внутри кода (решение 2026-08-12)", () => {
    const out = sanitizeWikiContent("```env\nOWNER=real.name@example.com\n```");
    expect(out).toContain("<email-redacted>");
    expect(out).not.toContain("real.name@example.com");
  });

  test("многоуровневый домен режется целиком", () => {
    const out = sanitizeWikiContent("свяжись: ivan@mail.sub.example.co.uk");
    expect(out).toContain("<email-redacted>");
    expect(out).not.toContain("example.co.uk");
  });

  test("телефон не задет", () => {
    expect(sanitizeWikiContent("call +1-555-867-5309 today")).toContain(
      "<phone-redacted>",
    );
  });

  test("правило хэндла не тронуто", () => {
    expect(sanitizeWikiTitle("Заметка от @dobropalm")).toContain(
      "<handle-redacted>",
    );
  });
});
