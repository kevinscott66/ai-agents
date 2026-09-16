/**
 * Аудит 2026-08-21: инлайновый светлый фон + цвет текста из темы = белым по
 * белому.
 *
 * Mini App живёт внутри Telegram и красится его темой: `styles.css:4-5`
 * объявляет `--bg`/`--text` из `--tg-theme-*`, а `body` берёт оба. Инлайновый
 * `style={{ background: "#fff" }}` перебивает только фон — цвет текста
 * продолжает приходить из темы. В тёмной теме Telegram это `#ffffff`.
 *
 * Замерено (контраст WCAG, текст темы на инлайновом фоне):
 *
 *   место                              фон       светлая  тёмная  AA(4.5)
 *   Mac.tsx, карточка сессии           #ffffff   18.88    1.00   ПРОВАЛ
 *   Mac.tsx, она же выбранная          #f8f9fa   17.91    1.05   ПРОВАЛ
 *   Mac.tsx, вывод сессии              #f8f9fa   17.91    1.05   ПРОВАЛ
 *   Mac.tsx, карточка истории          #ffffff   18.88    1.00   ПРОВАЛ
 *   Settings.tsx, карточка агента      #ffffff   18.88    1.00   ПРОВАЛ
 *   Settings.tsx, <select> модели      #ffffff   18.88    1.00   ПРОВАЛ
 *
 * 1.00 — это не «плохо читается», это ровно ноль разницы: имя проекта в
 * карточке mac-сессии, весь вывод сессии и название роли в настройках
 * бюджетов пропадали целиком. Тот же класс дефекта CSS уже защищает у бейджей
 * (`.badge` обязан иметь фон по умолчанию, tests/miniapp-badge-contrast.test.ts)
 * — но инлайновый стиль проходит мимо CSS и мимо той проверки.
 *
 * Инвариант: если фон задан инлайном и он светлый, в том же объекте стиля
 * обязан быть `color`. Токены темы (`var(--bg)`, `var(--secondary-bg)`) под
 * правило не попадают — они и есть правильный ответ: меняются вместе с текстом.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "miniapp", "src");

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...tsxFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Относительная яркость по WCAG. */
export function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const parts = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const lin = parts.map((x) =>
    x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

interface StyleSite {
  /** Тело `style={{ … }}`. */
  body: string;
  /** Атрибуты элемента до `style=` — там ищем разметку. */
  attrs: string;
  /** JSX без детей (`… />`) текста содержать не может по определению. */
  selfClosing: boolean;
}

/** Каждый `style={{ … }}` вместе с элементом, которому принадлежит. */
export function styleSites(src: string): StyleSite[] {
  const out: StyleSite[] = [];
  const MARK = "style={{";
  let at = src.indexOf(MARK);
  while (at !== -1) {
    let depth = 2;
    let i = at + MARK.length;
    const from = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    const tagStart = src.lastIndexOf("<", at);
    const tagEnd = src.indexOf(">", i);
    out.push({
      body: src.slice(from, i - 2),
      attrs: tagStart === -1 ? "" : src.slice(tagStart, at),
      selfClosing: tagEnd > 0 && src.slice(i, tagEnd).trimEnd().endsWith("/"),
    });
    at = src.indexOf(MARK, i);
  }
  return out;
}

const HEX = /(?:background|backgroundColor)\s*:\s*[^,}]*?(#[0-9a-fA-F]{3,6})/g;

/** Светлым считаем фон, на котором белый текст не даёт AA (4.5:1). */
const LIGHT_LUM = 0.184; // ratio(#fff, bg) = 4.5 ⇔ lum(bg) ≈ 0.184

export function hasOwnColor(body: string): boolean {
  return /(^|[\s,{])color\s*:/.test(body);
}

function offenders(): string[] {
  const bad: string[] = [];
  for (const file of tsxFiles(SRC)) {
    const where = file.slice(SRC.length + 1);
    for (const site of styleSites(readFileSync(file, "utf8"))) {
      const hexes = [...site.body.matchAll(HEX)].map((m) => m[1]);
      if (hexes.length === 0) continue;
      if (!hexes.some((h) => luminance(h) > LIGHT_LUM)) continue;
      if (hasOwnColor(site.body)) continue;
      // Ни детей, ни разметки для текста — красить нечего.
      if (site.selfClosing) continue;
      if (/aria-hidden=\{?"?true/.test(site.attrs)) continue;
      bad.push(`${where}: ${hexes.join(" ")}`);
    }
  }
  return bad;
}

describe("инлайновый светлый фон без своего цвета текста", () => {
  test("ни одного места во всём src/", () => {
    expect(offenders()).toEqual([]);
  });

  test("сама проверка ловит дефект — контроль на синтетическом образце", () => {
    // Иначе «ноль находок» неотличим от сломанного сканера.
    const sample = `<div style={{ padding: 12, background: "#fff" }}>x</div>`;
    const sites = styleSites(sample);
    expect(sites.length).toBe(1);
    expect(sites[0].selfClosing).toBe(false);
    expect(luminance("#fff")).toBeGreaterThan(LIGHT_LUM);
    expect(hasOwnColor(sites[0].body)).toBe(false);
  });

  test("исключения работают по структуре, а не по списку файлов", () => {
    const selfClosed = styleSites(
      `<div style={{ height: 6, background: "#ecf0f1" }} />`,
    )[0];
    expect(selfClosed.selfClosing).toBe(true);

    const marked = styleSites(
      `<div aria-hidden="true" style={{ background: "#ecf0f1" }}>x</div>`,
    )[0];
    expect(marked.selfClosing).toBe(false);
    expect(/aria-hidden=\{?"?true/.test(marked.attrs)).toBe(true);
  });

  test("порог светлоты соответствует AA с белым текстом", () => {
    const ratio = (bg: string) => (1.0 + 0.05) / (luminance(bg) + 0.05);
    expect(ratio("#f8f9fa")).toBeLessThan(4.5); // светлый — под запретом
    expect(ratio("#586069")).toBeGreaterThan(4.5); // фон бейджа — легален
    expect(luminance("#f8f9fa")).toBeGreaterThan(LIGHT_LUM);
    expect(luminance("#586069")).toBeLessThan(LIGHT_LUM);
  });

  test("тёмный фон с белым текстом проверку не задевает", () => {
    // Бейджи и кнопки задают пару фон+цвет и остаются как были.
    const sample = `<span style={{ background: "#3498db", color: "#fff" }} />`;
    expect(hasOwnColor(styleSites(sample)[0].body)).toBe(true);
  });
});

describe("исправленные места используют токены темы", () => {
  const mac = readFileSync(join(SRC, "pages", "Mac.tsx"), "utf8");
  const settings = readFileSync(join(SRC, "pages", "Settings.tsx"), "utf8");

  test("карточки mac-сессий красятся темой", () => {
    expect(mac).toContain('? "var(--secondary-bg)"');
    expect(mac).toContain(': "var(--bg)"');
    expect(mac).not.toContain('"#f8f9fa"');
  });

  test("панель вывода сессии — вторичный фон темы", () => {
    expect(mac).toContain('backgroundColor: "var(--secondary-bg)"');
  });

  test("карточка агента и <select> в настройках — фон темы", () => {
    expect(settings).toContain('background: "var(--bg)"');
    expect(settings).toContain('color: "var(--text)"');
  });
});
