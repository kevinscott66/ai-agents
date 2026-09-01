/**
 * Аудит 2026-08-28: проверка внешних ссылок отказывала на своих же.
 *
 * `HREF_ATTR` начинался с `\b`, а граница слова стоит и после дефиса: в
 * `data-href="…"` она ровно перед `href`. Атрибут `data-*` для resvg инертен —
 * он его не резолвит и не читает, — но весь рендер падал с текстом
 * «внешняя ссылка запрещена — href="…"», называя атрибут, которого модель не
 * писала. Модель этот атрибут не находит и правит вслепую.
 *
 * Второе: ссылка внутрь документа, записанная числовой ссылкой (`&#35;id`), не
 * начинается с `#` — и тоже отвергалась. XML-парсер эти ссылки разворачивает
 * до того, как resvg увидит значение, так что для него это обычный `#id`.
 *
 * Обе правки только СНИМАЮТ ложные отказы. Обхода они не открывают: чтобы
 * пройти, значение должно оказаться `#…` или `data:…` уже после разворота, то
 * есть ровно тем, что увидит resvg. `<!ENTITY>` запрещён отдельной проверкой
 * выше, так что своих сущностей в документе нет.
 */
import { describe, expect, test } from "bun:test";
import { findExternalHref } from "../lib/svg-render.ts";

const wrap = (attrs: string) => `<svg xmlns="http://www.w3.org/2000/svg"><image ${attrs}/></svg>`;

describe("чужие атрибуты не считаются ссылкой", () => {
  test("data-href игнорируется", () => {
    expect(findExternalHref(wrap('data-href="https://evil.example/x.png"'))).toBeNull();
  });

  test("любой другой дефисный суффикс тоже", () => {
    // Только суффиксы, без двоеточия: `data-xlink:href` — это префикс
    // пространства имён, и он ссылка (audit-2026-08-28-svg-href-prefix-hyphen).
    for (const a of ["my-href", "x-href", "foo-bar-href"]) {
      expect(findExternalHref(wrap(`${a}="/etc/passwd"`))).toBeNull();
    }
  });

  test("настоящий href рядом с data-href всё равно находится", () => {
    const svg = wrap('data-href="#local" href="https://evil.example/x.png"');
    expect(findExternalHref(svg)).toBe("https://evil.example/x.png");
  });
});

describe("числовые ссылки разворачиваются перед решением", () => {
  test("&#35;id — это внутренняя ссылка", () => {
    expect(findExternalHref(wrap('href="&#35;grad1"'))).toBeNull();
  });

  test("шестнадцатеричная форма тоже", () => {
    for (const ref of ["&#x23;grad1", "&#X23;grad1"]) {
      expect(findExternalHref(wrap(`href="${ref}"`))).toBeNull();
    }
  });

  test("закодированный data: не превращается в внешнюю ссылку", () => {
    expect(findExternalHref(wrap('href="&#100;ata:image/png;base64,AAAA"'))).toBeNull();
  });

  test("закодированный путь наружу по-прежнему отвергается", () => {
    // Разворот работает в обе стороны и обхода не даёт: `&#47;` — это `/`.
    expect(findExternalHref(wrap('href="&#47;etc/passwd"'))).toBe("/etc/passwd");
  });
});

describe("прежнее поведение сохранено", () => {
  test("внешние ссылки отвергаются", () => {
    for (const v of ["https://evil.example/x.png", "/etc/passwd", "./x.png", "x.png", "//cdn/x"]) {
      expect(findExternalHref(wrap(`href="${v}"`))).toBe(v);
    }
  });

  test("xlink:href наружу отвергается", () => {
    expect(findExternalHref(wrap('xlink:href="/etc/passwd"'))).toBe("/etc/passwd");
  });

  test("внутренние и data: пропускаются", () => {
    expect(findExternalHref(wrap('xlink:href="#gradient"'))).toBeNull();
    expect(findExternalHref(wrap('href="  #gradient  "'))).toBeNull();
    expect(findExternalHref(wrap('href="data:image/png;base64,AAAA"'))).toBeNull();
    expect(findExternalHref(wrap("href='#gradient'"))).toBeNull();
  });

  test("одинарные кавычки и пробелы вокруг = разбираются", () => {
    expect(findExternalHref(wrap("href = '/etc/passwd'"))).toBe("/etc/passwd");
  });

  test("документ без ссылок — null", () => {
    expect(findExternalHref('<svg><rect width="10" height="10"/></svg>')).toBeNull();
  });
});
