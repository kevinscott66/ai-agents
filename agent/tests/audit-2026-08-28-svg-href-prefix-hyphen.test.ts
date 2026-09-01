/**
 * Аудит 2026-08-28 (повторный): запрет внешних ссылок обходился дефисом.
 *
 * Утренняя правка того же дня взяла префикс любым — но классом `[A-Za-z_][\w.]*`,
 * то есть без дефиса. Обоснование в шапке: «для roxmltree `data-xlink` —
 * неизвестный префикс, документ отвергается на разборе». Верно это только для
 * НЕобъявленного префикса. `a-b` — законный NCName, и `xmlns:a-b` со ссылкой на
 * URI xlink резолвится штатно: атрибут читается, файл впечатывается в растр,
 * а мерка возвращает null. Ровно тот же обход, что закрывали утром, только
 * с дефисом в шапке вместо второй строки. Юникодный префикс (`é-b`) не
 * подходил под `\w` и работал так же.
 *
 * Проверяем измерением, а не рассуждением: пустой квадрат против того же
 * квадрата со ссылкой на локальный файл. Совпадение размеров с честным
 * `xlink:href` и есть доказательство, что файл прочитан.
 *
 * `data-href` без двоеточия ссылкой не считается по-прежнему — это отдельный
 * инвариант (audit-2026-08-28-svg-href-false-reject), и он здесь закреплён.
 */
import { describe, expect, test } from "bun:test";
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";
import { findExternalHref, renderSvgToPng } from "../lib/svg-render.ts";

const LOGO = fileURLToPath(new URL("../assets/delabs-logo-transparent.png", import.meta.url));
const XLINK = "http://www.w3.org/1999/xlink";

const doc = (ns: string, attrs: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg"${ns}` +
  ` width="64" height="64"><rect width="64" height="64" fill="#fff"/>` +
  `<image ${attrs} x="0" y="0" width="64" height="64"/></svg>`;

const png = (svg: string) => new Resvg(svg).render().asPng().length;

const EMPTY = png(
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">' +
    '<rect width="64" height="64" fill="#fff"/></svg>',
);

describe("предпосылки: дефисный префикс резолвится и читает файл", () => {
  test("a-b:href даёт тот же растр, что честный xlink:href", () => {
    const honest = png(doc(` xmlns:xlink="${XLINK}"`, `xlink:href="${LOGO}"`));
    const hyphen = png(doc(` xmlns:a-b="${XLINK}"`, `a-b:href="${LOGO}"`));
    expect(honest).not.toBe(EMPTY);
    expect(hyphen).toBe(honest);
  });

  test("юникодный префикс — тоже", () => {
    expect(png(doc(` xmlns:é-b="${XLINK}"`, `é-b:href="${LOGO}"`))).not.toBe(EMPTY);
  });

  test("необъявленный префикс документ не переживает — терять было нечего", () => {
    expect(() => png(doc("", `data-xlink:href="${LOGO}"`))).toThrow();
  });
});

describe("гард видит ссылку под любым префиксом", () => {
  test("дефис в префиксе", () => {
    expect(findExternalHref(doc(` xmlns:a-b="${XLINK}"`, `a-b:href="${LOGO}"`))).toBe(LOGO);
  });

  test("юникод, точка, подчёркивание, цифры", () => {
    for (const p of ["é-b", "a.b", "_x", "ns1"]) {
      expect(findExternalHref(doc(` xmlns:${p}="${XLINK}"`, `${p}:href="/etc/hosts"`))).toBe(
        "/etc/hosts",
      );
    }
  });

  test("data-xlink:href — это префикс, а не суффикс, и он ссылка", () => {
    expect(findExternalHref(doc("", 'data-xlink:href="/etc/hosts"'))).toBe("/etc/hosts");
  });

  test("рендер отказывает, а не рисует", async () => {
    await expect(renderSvgToPng(doc(` xmlns:a-b="${XLINK}"`, `a-b:href="${LOGO}"`))).rejects.toThrow(
      /внешн/i,
    );
  });
});

describe("ложные отказы не расползлись", () => {
  test("дефисный суффикс без двоеточия ссылкой не стал", () => {
    for (const a of ["data-href", "my-href", "x-href", "foo-bar-href"]) {
      expect(findExternalHref(doc("", `${a}="/etc/hosts"`))).toBeNull();
    }
  });

  test("настоящая ссылка рядом с таким атрибутом всё равно находится", () => {
    expect(findExternalHref(doc("", 'data-href="#local" href="/etc/hosts"'))).toBe("/etc/hosts");
  });

  test("внутренние ссылки и data: по-прежнему проходят", () => {
    expect(findExternalHref(doc(` xmlns:a-b="${XLINK}"`, 'a-b:href="#grad"'))).toBeNull();
    expect(findExternalHref(doc(` xmlns:a-b="${XLINK}"`, 'a-b:href="&#35;grad"'))).toBeNull();
    expect(
      findExternalHref(doc(` xmlns:a-b="${XLINK}"`, 'a-b:href="data:image/png;base64,AA"')),
    ).toBeNull();
  });
});
