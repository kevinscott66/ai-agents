// Аудит 2026-08-20: порт сервера сайта брался из env без проверки.
//
// `const PORT = Number(process.env.PORT ?? 8790)` — `??` подставляет дефолт
// только когда переменной нет вовсе. Пустая строка переменной ЕСТЬ, и
// `Number("")` это 0, а `Bun.serve({ port: 0 })` занимает случайный свободный
// порт. nginx на проде ходит строго в 127.0.0.1:8790, tonutils-reverse-proxy
// тоже (`proxy_pass: http://127.0.0.1:8790/`), так что сайт целиком отвечал бы
// 502 — при живом процессе, без ошибки в логах и с бодрым "listening" в stdout.
// Строка `PORT=` в EnvironmentFile или `PORT: ""` в docker-compose даёт ровно
// это. Соседние числовые переменные того же файла (`SITE_TRUSTED_PROXY_HOPS`,
// `SITE_LOOPBACK_RL_CAPACITY`) уже прикрыты `Number.isFinite`; порт — нет, и он
// из них троих единственный, кто решает, доступен сайт вообще или нет.
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { serverPort, DEFAULT_PORT } from "./index.ts";

/**
 * Один вызов `serverPort()` при заданном `PORT`: возвращает и результат, и
 * число предупреждений. `console.warn` подменяется, чтобы негодные значения не
 * засоряли вывод тестов и чтобы «не молчит» само было проверяемым.
 */
function run(v: string | undefined): { port: number; warns: string[] } {
  const beforeEnv = process.env.PORT;
  const origWarn = console.warn;
  const warns: string[] = [];
  try {
    if (v === undefined) delete process.env.PORT;
    else process.env.PORT = v;
    console.warn = (...a: unknown[]) => {
      warns.push(a.map(String).join(" "));
    };
    return { port: serverPort(), warns };
  } finally {
    console.warn = origWarn;
    if (beforeEnv === undefined) delete process.env.PORT;
    else process.env.PORT = beforeEnv;
  }
}

describe("serverPort: значение по умолчанию", () => {
  test("канонический дефолт — 8790, тот же, что ждёт nginx", () => {
    expect(DEFAULT_PORT).toBe(8790);
  });

  test("переменной нет → дефолт, без предупреждения", () => {
    const r = run(undefined);
    expect(r.port).toBe(DEFAULT_PORT);
    expect(r.warns).toEqual([]);
  });

  test("пустая строка → дефолт, а не 0 (случайный свободный порт)", () => {
    expect(run("").port).toBe(DEFAULT_PORT);
    expect(run("").port).not.toBe(0);
  });

  test("пробельная строка → дефолт", () => {
    expect(run("   ").port).toBe(DEFAULT_PORT);
  });
});

describe("serverPort: годные значения проходят как есть", () => {
  test("обычный порт", () => {
    const r = run("3000");
    expect(r.port).toBe(3000);
    expect(r.warns).toEqual([]);
  });

  test("сам дефолт, заданный явно", () => {
    const r = run("8790");
    expect(r.port).toBe(8790);
    expect(r.warns).toEqual([]);
  });

  test("окружающие пробелы не мешают", () => {
    const r = run(" 3000 ");
    expect(r.port).toBe(3000);
    expect(r.warns).toEqual([]);
  });

  test("границы диапазона допустимы", () => {
    expect(run("1").port).toBe(1);
    expect(run("65535").port).toBe(65535);
    expect(run("1").warns).toEqual([]);
    expect(run("65535").warns).toEqual([]);
  });
});

describe("serverPort: негодные значения откатываются к дефолту и не молчат", () => {
  const bad = [
    "0",
    "-1",
    "abc",
    "3000.5",
    "65536",
    "99999",
    "NaN",
    "8790abc",
    "Infinity",
  ];
  for (const v of bad) {
    test(`PORT=${JSON.stringify(v)} → дефолт + ровно одно предупреждение`, () => {
      const r = run(v);
      expect(r.port).toBe(DEFAULT_PORT);
      expect(r.warns).toHaveLength(1);
    });
  }

  test("предупреждение называет и переменную, и подставленный порт", () => {
    const r = run("");
    expect(r.warns).toHaveLength(1);
    expect(r.warns[0]).toContain("PORT");
    expect(r.warns[0]).toContain("8790");
  });
});

describe("serverPort: точка входа действительно им пользуется", () => {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf-8");
  // Докблок функции цитирует прежнюю строку целиком — по сырому тексту
  // «старого кода не осталось» не проверить. Комментарии срезаем; грубо, но
  // ошибиться такой стриппер может только в сторону послабления.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");

  test("Bun.serve получает порт из serverPort()", () => {
    expect(src).toContain("port: serverPort()");
  });

  test("сырого Number(process.env.PORT ...) в коде не осталось", () => {
    expect(code).not.toContain("Number(process.env.PORT");
    // Стриппер не съел сам вызов — иначе проверка выше проходила бы впустую.
    expect(code).toContain("port: serverPort()");
  });

  test("дефолт объявлен константой, а не вписан в возврат", () => {
    expect(src).toMatch(/export const DEFAULT_PORT = 8790;/);
  });
});
