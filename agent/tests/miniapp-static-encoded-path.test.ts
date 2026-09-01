/**
 * Аудит 2026-08-12: закодированный слэш в пути ронял раздачу статики в 500.
 *
 * serveStatic (lib/miniapp-server.ts) собирал путь так:
 *
 *   let rel = url.pathname.replace(/^\/+/, "");   // pathname НЕ декодирован
 *   if (rel.includes("..")) return null;
 *   let fileUrl = new URL(rel, distRoot);
 *   let file = Bun.file(fileUrl);
 *
 * `URL.pathname` отдаёт путь как есть, вместе с процентными последовательностями.
 * На `%2f` внутри сегмента конструкция бросает
 *
 *   TypeError: URL must be a non-empty "file:" path
 *
 * — то есть обычный битый линк или сканер даёт 500 (внутренняя ошибка) там, где
 * должен быть 404. 500 в логе — это сигнал «сломался сервер», и такие пути
 * замусоривают его на ровном месте.
 *
 * Проверка `rel.includes("..")` при этом смотрела на НЕдекодированную строку:
 * `..%2f` она ловит, а `%2e%2e%2f` — нет. Обхода это не давало (парсер URL
 * нормализует `%2e%2e` ещё до pathname — замер: `/%2e%2e/package.json` даёт
 * pathname `/package.json`), но опираться на нормализацию в парсере вместо
 * собственной проверки — это удача, а не защита.
 *
 * Инвариант: любой путь, который не резолвится в файл внутри miniapp/dist,
 * даёт штатный ответ (404 или SPA-фолбэк), а не 500; проверка на выход за
 * пределы каталога делается по РАЗОБРАННОМУ абсолютному пути.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  startMiniappServer,
  type MiniappServerHandle,
} from "../lib/miniapp-server.ts";
import { _resetRateLimiter } from "../lib/http-utils.ts";

let server: MiniappServerHandle;
let base: string;

beforeAll(() => {
  server = startMiniappServer({
    port: 0,
    allowedUserIds: [900_801],
    adminUserIds: [900_801],
    botToken: "test_bot_token_for_static_paths",
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop();
  _resetRateLimiter();
});

/** Всё, что не 5xx — штатный ответ: 404, SPA-фолбэк или 200 на реальный файл. */
async function status(path: string): Promise<number> {
  const r = await fetch(`${base}${path}`);
  await r.text();
  return r.status;
}

describe("serveStatic: закодированные пути не дают 500", () => {
  test("%2f внутри сегмента — не 500", async () => {
    expect(await status("/a%2fb")).toBeLessThan(500);
  });

  test("%2e%2e%2f — не 500 и не отдаёт файл вне dist", async () => {
    const r = await fetch(`${base}/%2e%2e%2f%2e%2e%2fpackage.json`);
    const body = await r.text();
    expect(r.status).toBeLessThan(500);
    expect(body).not.toInclude('"dependencies"');
  });

  test("..%2f — не 500 и не отдаёт файл вне dist", async () => {
    const r = await fetch(`${base}/..%2fpackage.json`);
    const body = await r.text();
    expect(r.status).toBeLessThan(500);
    expect(body).not.toInclude('"dependencies"');
  });

  test("битая процентная последовательность — не 500", async () => {
    expect(await status("/%zz")).toBeLessThan(500);
  });

  test("нулевой байт в пути — не 500", async () => {
    expect(await status("/a%00b.js")).toBeLessThan(500);
  });

  test("системные маршруты по-прежнему не перехватываются статикой", async () => {
    expect(await status("/healthz")).toBe(200);
  });
});
