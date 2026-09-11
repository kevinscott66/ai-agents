/**
 * Аудит 2026-08-12: SVG от модели мог читать файлы с диска и присылать их картинкой.
 *
 * `GENERATE_SVG_IMAGE` берёт svg-разметку прямо из payload'а модели и отдаёт её
 * в `renderSvgToPng` → resvg. Правило «никаких внешних ассетов» существовало
 * только как просьба: в SYSTEM_PROMPT у svg-фолбэка написано «no external
 * assets, no <image> tags», а в коде не проверялось ничего.
 *
 * resvg (usvg) без каталога ресурсов резолвит href как путь файловой системы —
 * а задать его через @resvg/resvg-js нельзя: биндинг такой опции не отдаёт —
 * абсолютный работает как есть. Замер до правки на этой машине: пустой
 * 64×64 SVG рендерится в 174 байта PNG, тот же SVG с
 * `<image href="/…/secret.png" …/>` — в 215 байт. То есть файл прочитан и
 * впечатан в растр. Растр после этого уходит в чат через tgSendPhoto.
 *
 * Читаются только то, что resvg умеет декодировать (png/jpeg/gif/svg) — .env и
 * sqlite так не вытащить. Но это всё равно чтение файлов сервиса по строке,
 * которую пишет модель, а модель в этом проекте читает недоверенный вход:
 * web_search, входящие вложения (READ_FILE), сообщения. Ни апрува, ни следа в
 * логе у этого нет — в чат приезжает просто «картинка от дизайнера».
 *
 * Сеть resvg не ходит (проверено: http-href даёт тот же пустой растр), XXE и
 * billion-laughs режет парсер roxmltree — они здесь для регресса.
 *
 * Инвариант: в SVG, пришедшем от модели, href ведёт либо внутрь документа
 * (`#id` — <use>, <textPath>, наследование градиентов), либо в `data:`.
 * Всё остальное — отказ. Доверенный композит баннера сюда не заходит: у него
 * свой renderBrandSvgToPng, и лого/фон там и так base64.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { renderSvgToPng } from "../lib/svg-render.ts";

const DIR = process.env.TMPDIR ?? "/tmp";
const SECRET = `${DIR}/audit-svg-secret.png`;
let secretDataUri = "";

beforeAll(async () => {
  const png = await renderSvgToPng(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#ff0000"/></svg>`,
  );
  await Bun.write(SECRET, png);
  secretDataUri = `data:image/png;base64,${png.toString("base64")}`;
});

const wrap = (inner: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="64" height="64">${inner}</svg>`;

describe("внешние ссылки в SVG от модели", () => {
  test("абсолютный путь к файлу — отказ", async () => {
    const svg = wrap(`<image href="${SECRET}" width="64" height="64"/>`);
    await expect(renderSvgToPng(svg)).rejects.toThrow(/href/i);
  });

  test("file:// — отказ", async () => {
    await expect(renderSvgToPng(wrap(`<image href="file:///etc/hosts" width="64" height="64"/>`)))
      .rejects.toThrow(/href/i);
  });

  test("http(s) — отказ", async () => {
    await expect(
      renderSvgToPng(
        wrap(`<image xlink:href="http://169.254.169.254/latest/meta-data/" width="64" height="64"/>`),
      ),
    ).rejects.toThrow(/href/i);
  });

  test("относительный путь — отказ", async () => {
    await expect(renderSvgToPng(wrap(`<image href="data/banners/x.png" width="64" height="64"/>`)))
      .rejects.toThrow(/href/i);
  });

  test("в тексте ошибки видно, что именно отклонили", async () => {
    try {
      await renderSvgToPng(wrap(`<image href="/etc/hosts" width="64" height="64"/>`));
      throw new Error("должно было отказать");
    } catch (e) {
      expect((e as Error).message).toContain("/etc/hosts");
    }
  });
});

describe("легальные ссылки не ломаем", () => {
  test("внутренняя ссылка #id (use) рендерится", async () => {
    const svg = wrap(
      `<defs><rect id="sq" width="32" height="32" fill="#0a0"/></defs><use xlink:href="#sq" x="8" y="8"/>`,
    );
    const png = await renderSvgToPng(svg);
    expect(png.length).toBeGreaterThan(0);
  });

  test("наследование градиента через xlink:href рендерится", async () => {
    const svg = wrap(
      `<defs><linearGradient id="a"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>` +
        `<linearGradient id="b" xlink:href="#a" x1="0" y1="0" x2="1" y2="1"/></defs>` +
        `<rect width="64" height="64" fill="url(#b)"/>`,
    );
    const png = await renderSvgToPng(svg);
    expect(png.length).toBeGreaterThan(0);
  });

  test("data: URI по-прежнему встраивается", async () => {
    const blank = await renderSvgToPng(wrap(""));
    const withImg = await renderSvgToPng(
      wrap(`<image href="${secretDataUri}" width="64" height="64"/>`),
    );
    expect(withImg.length).not.toBe(blank.length);
  });

  test("SVG без единого href рендерится", async () => {
    const png = await renderSvgToPng(wrap(`<circle cx="32" cy="32" r="30" fill="#123"/>`));
    expect(png.length).toBeGreaterThan(0);
  });
});

/**
 * Раньше эти два случая отбивал парсер roxmltree внутри конструктора Resvg —
 * отсюда и название «регресс». Отбивал он их правильно, но дорого: ~3.9 с
 * синхронно занятого event-loop'а на каждый, потому что в обоих есть `<text>`,
 * а значит конструктор успевал загрузить системные шрифты ДО того, как упасть
 * на разборе. Теперь оба отсекает `hasEntityDecl` по тексту, до конструктора, —
 * парсер остаётся вторым рубежом.
 *
 * Проверяем и то, и другое: что отказ есть и что он наш (по тексту сообщения).
 */
describe("сущности в DTD: отказ до конструктора", () => {
  test("внешняя сущность (XXE) не резолвится", async () => {
    const svg =
      `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/hosts">]>` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text>&xxe;</text></svg>`;
    await expect(renderSvgToPng(svg)).rejects.toThrow(/ENTITY/i);
  });

  test("рекурсивные сущности отбиваются", async () => {
    const svg =
      `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "&b;"><!ENTITY b "&a;">]>` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><text>&a;</text></svg>`;
    await expect(renderSvgToPng(svg)).rejects.toThrow(/ENTITY/i);
  });

  // Граница: отказ должен быть по объявлению сущности, а не по DOCTYPE вообще.
  // Легаси-шапку SVG 1.1 пишут старые редакторы, читать ей нечего.
  test("легаси DOCTYPE без сущностей рендерится", async () => {
    const svg =
      `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ` +
      `"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">` +
      `<rect width="64" height="64" fill="#0a0"/></svg>`;
    const png = await renderSvgToPng(svg);
    expect(png.length).toBeGreaterThan(0);
  });
});
