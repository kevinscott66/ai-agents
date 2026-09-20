/**
 * Аудит 2026-09-19 (AUD-023): публичный origin был зашит в index.ts константой
 * `https://delabs.space`. Его берут RSS, sitemap, robots и og:url — то есть
 * ровно те ссылки, которые уходят наружу и живут потом в агрегаторах и в
 * канале. После переезда домен стал обслуживать другой код и другой корпус, а
 * этот backend продолжал звать читателя туда: по ссылке из ленты — 404 или
 * чужой материал, canonical — на несуществующую здесь страницу.
 *
 * Инвариант: origin берётся из окружения, умолчание совпадает с прежней
 * константой (выкладка, не знающая про переменную, не меняет поведения), а
 * негодное значение роняет старт, а не подменяет ссылки молча.
 *
 * Почему падение, а не откат к умолчанию: тихий откат — это в точности тот
 * отказ, из-за которого пункт и завели. Сервис поднялся бы «успешно», а лента
 * продолжила бы уводить читателей не туда, и заметить это можно только снаружи
 * и сильно позже.
 */
import { describe, expect, test } from "bun:test";
import { resolveSiteOrigin } from "./index.ts";

describe("resolveSiteOrigin", () => {
  test("без переменной — прежняя константа", () => {
    expect(resolveSiteOrigin(undefined)).toBe("https://delabs.space");
    expect(resolveSiteOrigin("")).toBe("https://delabs.space");
    // Пустая переменная в unit-файле systemd — обычное дело, и это не «задано».
    expect(resolveSiteOrigin("   ")).toBe("https://delabs.space");
  });

  test("принимает голый origin и срезает хвостовой слэш", () => {
    // Слэш обязан уйти: ссылки строятся как `${origin}/digest/<id>`, иначе
    // получится `https://host//digest/<id>` — другой URL для краулера.
    expect(resolveSiteOrigin("https://example.org")).toBe("https://example.org");
    expect(resolveSiteOrigin("https://example.org/")).toBe("https://example.org");
    expect(resolveSiteOrigin("  https://example.org/  ")).toBe("https://example.org");
    expect(resolveSiteOrigin("https://example.org:8443")).toBe("https://example.org:8443");
    // http нужен для локальной проверки ленты без TLS.
    expect(resolveSiteOrigin("http://127.0.0.1:8790")).toBe("http://127.0.0.1:8790");
  });

  test("негодное значение роняет старт, а не подменяет ссылки", () => {
    for (const bad of [
      "delabs.space", // без схемы: самая вероятная опечатка в env
      "https://example.org/base", // путь дал бы двойной слэш в каждой ссылке
      "https://example.org/?utm=1",
      "https://example.org/#top",
      "ftp://example.org",
      "javascript:alert(1)",
      "https://user:pw@example.org",
      "не адрес",
    ]) {
      expect(() => resolveSiteOrigin(bad)).toThrow(/SITE_ORIGIN/);
    }
  });

  test("сообщение об ошибке называет само значение", () => {
    // Иначе в журнале сервиса видно «сервис не поднялся» и больше ничего.
    expect(() => resolveSiteOrigin("delabs.space")).toThrow(/"delabs\.space"/);
  });
});
