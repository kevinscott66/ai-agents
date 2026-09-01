/**
 * Аудит 2026-08-28: запрет внешних ссылок обходился переименованием префикса.
 *
 * `findExternalHref` искала `href` и `xlink:href` — ровно две написанные
 * строки. Но resvg (roxmltree) резолвит атрибут ПО URI пространства имён, а не
 * по буквам префикса: `xmlns:xl="http://www.w3.org/1999/xlink"` плюс
 * `xl:href="/абсолютный/путь"` — это тот же самый xlink href, и файл читается.
 * Замер на этой машине (probe): пустой 64×64 даёт 174 байта PNG, он же с
 * `xlink:href` на лого — 2162, и он же с `xl:href` — те же 2162, но мерка
 * возвращала null.
 *
 * То есть правило 2026-08-12 («никаких внешних ассетов») снималось одной
 * лишней строкой в шапке документа. SVG сюда пишет модель, читающая
 * недоверенный вход (web_search, вложения, сообщения), у GENERATE_SVG_IMAGE
 * апрува нет, а растр уезжает картинкой в чат — то есть прочитанный файл
 * оказывается впечатан в изображение.
 *
 * Границу «какой префикс считается» правил повторный аудит того же дня —
 * см. audit-2026-08-28-svg-href-prefix-hyphen: дефис в префиксе оказался тем же
 * обходом на шаг дальше. Здесь остаётся то, что от этого не зависит.
 */
import { describe, expect, test } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";
import { findExternalHref, renderSvgToPng } from "../lib/svg-render.ts";

const LOGO = fileURLToPath(
  new URL("../assets/delabs-logo-transparent.png", import.meta.url),
);

function png(svg: string): number {
  return new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng().length;
}

const doc = (xmlns: string, attrs: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"${xmlns} width="64" height="64">` +
  `<image x="0" y="0" width="64" height="64" ${attrs}/></svg>`;

const XLINK = ' xmlns:xl="http://www.w3.org/1999/xlink"';
const EMPTY = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"></svg>`;

describe("предпосылки: resvg резолвит xlink по URI, а не по префиксу", () => {
  test("алиас, привязанный к xlink, читает файл так же, как xlink:", () => {
    const blank = png(EMPTY);
    const viaAlias = png(doc(XLINK, `xl:href="${LOGO}"`));
    expect(viaAlias).toBeGreaterThan(blank);
    expect(viaAlias).toBe(png(doc("", `href="${LOGO}"`)));
  });

  test("префикс, привязанный к чужому URI, инертен", () => {
    expect(png(doc(' xmlns:zz="urn:nope"', `zz:href="${LOGO}"`))).toBe(png(EMPTY));
  });
});

describe("findExternalHref ловит любой префикс", () => {
  test("алиас xlink отвергается наравне с самим xlink", () => {
    expect(findExternalHref(doc(XLINK, `xl:href="${LOGO}"`))).toBe(LOGO);
    expect(findExternalHref(doc("", 'xlink:href="/etc/passwd"'))).toBe("/etc/passwd");
    expect(findExternalHref(doc("", 'svg:href="https://evil.example/x.png"'))).toBe(
      "https://evil.example/x.png",
    );
  });

  test("внутренняя ссылка через алиас по-прежнему проходит", () => {
    expect(findExternalHref(doc(XLINK, 'xl:href="#grad"'))).toBeNull();
    expect(findExternalHref(doc(XLINK, 'xl:href="&#35;grad"'))).toBeNull();
    expect(findExternalHref(doc(XLINK, 'xl:href="data:image/png;base64,AA"'))).toBeNull();
  });

  test("рендер отказывает, а не рисует", async () => {
    await expect(renderSvgToPng(doc(XLINK, `xl:href="${LOGO}"`))).rejects.toThrow(
      /внешняя ссылка/,
    );
  });
});

describe("прежние ложные отказы не вернулись (аудит 2026-08-28)", () => {
  test("дефисные суффиксы и data-* не считаются ссылкой", () => {
    // Без двоеточия: это суффикс имени, а не префикс пространства имён.
    // `data-xlink:href` переехал в audit-2026-08-28-svg-href-prefix-hyphen —
    // с двоеточием это уже настоящий префикс, и он ссылка.
    for (const a of ["data-href", "my-href", "x-href"]) {
      expect(findExternalHref(doc("", `${a}="/etc/passwd"`))).toBeNull();
    }
  });

  test("настоящая ссылка рядом с чужим атрибутом всё равно находится", () => {
    expect(
      findExternalHref(doc(XLINK, 'data-href="#local" xl:href="https://evil.example/x.png"')),
    ).toBe("https://evil.example/x.png");
  });

  test("свои же внутренние ссылки не ломаются", () => {
    expect(findExternalHref(doc("", 'href="#id"'))).toBeNull();
    expect(findExternalHref(doc("", 'href="&#x23;id"'))).toBeNull();
  });
});
