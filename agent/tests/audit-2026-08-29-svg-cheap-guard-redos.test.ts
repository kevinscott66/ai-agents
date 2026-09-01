/**
 * Аудит 2026-08-29 — обе дешёвые мерки в `svg-render.ts` были квадратичными.
 *
 * `findExternalHref` и `declaredRasterSize` выполняются СИНХРОННО в
 * родительском процессе, до `Bun.spawn` воркера: пока они считают, стоят все 12
 * ботов, HTTP-сервер Mini App и планировщики. `GENERATE_SVG_IMAGE` при этом не
 * за approval-гейтом и даёт 20 вызовов в минуту.
 *
 * Замеры на этой машине ДО правки (`bun run`, экспортируемые функции):
 *
 *   findExternalHref, `points="1,2,1,2,…"`:
 *     12KB -> 398мс | 25KB -> 1765мс | 50KB -> 7111мс | 100KB -> 27986мс
 *     (на потолке 200KB — около двух минут)
 *   declaredRasterSize, `"<svg ".repeat(n)`:
 *     10KB -> 70мс | 20KB -> 288мс | 40KB -> 704мс | 100KB -> 3346мс
 *
 * ПОСЛЕ правки те же входы на 200KB — единицы миллисекунд.
 *
 * Перф-проверка живёт в подпроцессе с жёстким таймаутом: замерять
 * настенное время внутри гейта нельзя (заснувший ноутбук красит его без
 * причины), а «дочерний процесс вообще не успел досчитать» — сигнал с запасом
 * в два порядка.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findExternalHref, declaredRasterSize } from "../lib/svg-render.ts";

const MODULE = fileURLToPath(new URL("../lib/svg-render.ts", import.meta.url));
const SPAWN_TIMEOUT_MS = 25_000;

describe("аудит 2026-08-29: мерки линейны на враждебном входе", () => {
  test(
    "200KB запятых и незакрытых тегов считаются, а не вешают процесс",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "svg-redos-"));
      try {
        const probe = join(dir, "probe.ts");
        writeFileSync(
          probe,
          `import { findExternalHref, declaredRasterSize } from ${JSON.stringify(MODULE)};\n` +
            // 1. Полигон из пар координат — то, что модель пишет сама.
            `const poly = '<svg><polygon points="' + '1,2,'.repeat(51000) + '0,0"/></svg>';\n` +
            `if (findExternalHref(poly) !== null) throw new Error("poly");\n` +
            // 2. То же, но с настоящей внешней ссылкой в самом конце: дешёвый
            //    отсев по подстроке `href` не срабатывает, работает регексп.
            `const tail = '<svg><polygon points="' + '1,2,'.repeat(51000) + '"/><image href="http://evil/x"/></svg>';\n` +
            `if (findExternalHref(tail) !== "http://evil/x") throw new Error("tail");\n` +
            // 3. Документ без единого `>`.
            `if (declaredRasterSize('<svg '.repeat(41000)) !== null) throw new Error("open");\n` +
            // 4. Незакрытая кавычка перед единственным `>` — случай, который
            //    «проверить наличие `>`» не покрывает.
            `if (declaredRasterSize('<svg x="'.repeat(25600) + '>') !== null) throw new Error("quote");\n` +
            `console.log("DONE");\n`,
        );
        const r = Bun.spawnSync({
          cmd: [process.execPath, "run", probe],
          cwd: dir,
          timeout: SPAWN_TIMEOUT_MS,
        });
        const out = r.stdout.toString() + r.stderr.toString();
        // exitCode === null означает, что подпроцесс убит по таймауту, то есть
        // мерка снова квадратичная.
        expect({ exitCode: r.exitCode, out: out.slice(0, 400) }).toEqual({
          exitCode: 0,
          out: "DONE\n",
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe("аудит 2026-08-29: разбор href не сузился", () => {
  test("префикс пространства имён по-прежнему считается ссылкой", () => {
    expect(findExternalHref('<image xlink:href="http://x/1"/>')).toBe(
      "http://x/1",
    );
    expect(findExternalHref('<image a-b:href="http://x/2"/>')).toBe(
      "http://x/2",
    );
    // Юникодный префикс — инвариант аудита 2026-08-28.
    expect(findExternalHref('<image é-b:href="http://x/3"/>')).toBe(
      "http://x/3",
    );
    expect(findExternalHref('<image data-xlink:href="http://x/4"/>')).toBe(
      "http://x/4",
    );
  });

  test("длинный префикс не даёт обхода", () => {
    // Потолок на длину префикса чинил бы замер, но открыл бы ровно это: имя
    // длиннее потолка перестало бы разбираться, а ссылка за ним — находиться.
    const long = "n".repeat(500);
    expect(findExternalHref(`<image ${long}:href="http://evil/x"/>`)).toBe(
      "http://evil/x",
    );
  });

  test("data-href ссылкой не считается", () => {
    expect(findExternalHref('<image data-href="http://x/5"/>')).toBeNull();
    expect(findExternalHref('<image myhref="http://x/6"/>')).toBeNull();
    expect(findExternalHref('<image a.href="http://x/7"/>')).toBeNull();
  });

  test("внутренние ссылки и data: пропускаются", () => {
    expect(findExternalHref('<use xlink:href="#gradient"/>')).toBeNull();
    expect(findExternalHref('<image href="data:image/png;base64,AAA"/>')).toBeNull();
    expect(findExternalHref('<image href=""/>')).toBeNull();
    expect(findExternalHref("<svg><rect/></svg>")).toBeNull();
  });

  test("одинарные кавычки и пробелы вокруг знака равенства", () => {
    expect(findExternalHref("<image href = 'http://x/8'/>")).toBe("http://x/8");
    // Числовые ссылки разбираются до сравнения — инвариант на месте.
    expect(findExternalHref('<image href="&#104;ttp://x/9"/>')).toBe(
      "http://x/9",
    );
  });
});

describe("аудит 2026-08-29: поиск тега стал проходом, а не регекспом", () => {
  test("кавычка с `>` внутри по-прежнему не обрывает тег", () => {
    expect(
      declaredRasterSize('<svg data-x="a>b" width="100000" height="100000">x</svg>'),
    ).toEqual({ width: 100000, height: 100000 });
    expect(
      declaredRasterSize("<svg data-x='a>b' width='512' height='256'>x</svg>"),
    ).toEqual({ width: 512, height: 256 });
  });

  test("обычные документы меряются как раньше", () => {
    expect(declaredRasterSize('<svg width="100" height="50"></svg>')).toEqual({
      width: 100,
      height: 50,
    });
    expect(declaredRasterSize('<svg width="1e5" height="1e5"></svg>')).toEqual({
      width: 100000,
      height: 100000,
    });
    // fitTo раздувает высоту — инвариант rasterSizeAfterFit.
    expect(
      declaredRasterSize('<svg width="100" height="100000"></svg>', 2048),
    ).toEqual({ width: 2048, height: 2048000 });
  });

  test("не тег, а начало слова — не совпадение", () => {
    expect(declaredRasterSize('<svgfoo width="10" height="10">')).toBeNull();
  });

  test("незакрытый тег меряется как «не знаю», а не как ошибка", () => {
    // Безопасная сторона: авторитетная проверка размера всё равно повторяется
    // в воркере уже по разобранному документу.
    expect(declaredRasterSize('<svg width="10" height="10"')).toBeNull();
    expect(declaredRasterSize('<svg x="')).toBeNull();
  });
});
