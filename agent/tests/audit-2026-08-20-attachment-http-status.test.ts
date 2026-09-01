/**
 * Аудит 2026-08-20: скачивание вложений не смотрело на код ответа.
 *
 *   const resp = await fetch(link.toString(), { signal: … });
 *   const ab   = await resp.arrayBuffer();      // ← 404? 500? всё равно
 *
 * `fetch` не бросает на 4xx/5xx. Telegram на протухший file_path отвечает
 * 404 с телом `{"ok":false,"error_code":404,"description":"Not Found"}` —
 * это ~60 байт, то есть проверки `> 4MB` / `> 1MB` оно проходит, и дальше
 * идёт как содержимое присланного пользователем файла:
 *
 *  - картинка уезжает в Anthropic как base64 с mediaType image/* → 400 от
 *    API → падает весь ход пользователя, и при этом в логе НИ СТРОКИ про
 *    404: исключения не было, catch рядом не сработал;
 *  - документ ещё тише: тело ошибки — валидный UTF-8, оно подмешивается в
 *    контекст, и модель разбирает JSON ошибки, думая что это report.md.
 *
 * Протухший file_path — не экзотика: ссылка из getFile живёт около часа, а
 * между апдейтом и скачиванием стоит очередь и sendChatAction. Плюс обычные
 * 5xx CDN.
 *
 * Соседний voice-handler.ts:138 этот код проверяет с самого начала. Две
 * версии «как скачать файл Telegram» разошлись в одном репозитории — ровно
 * тот же сюжет, что у скраббера секретов. Поэтому проверка теперь одна на
 * оба вызова: `fetchTelegramAttachment`.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchTelegramAttachment } from "../orchestrator/message-handler.ts";

const REAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

/** Ответ Telegram на протухший file_path — ровно в этой форме. */
const TG_404 = '{"ok":false,"error_code":404,"description":"Not Found"}';

function stubFetch(status: number, body: string): { calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { calls };
}

describe("вложение: не-2xx не превращается в содержимое файла", () => {
  test("404 от Telegram → исключение, а не 55 байт «файла»", async () => {
    stubFetch(404, TG_404);
    await expect(
      fetchTelegramAttachment("https://api.telegram.org/file/botX/y", "документ"),
    ).rejects.toThrow(/HTTP 404/);
  });

  test("5xx CDN тоже отказ, а не пустая картинка", async () => {
    stubFetch(502, "<html>Bad Gateway</html>");
    await expect(
      fetchTelegramAttachment("https://api.telegram.org/file/botX/y", "картинка"),
    ).rejects.toThrow(/HTTP 502/);
  });

  test("в сообщении об отказе видно, что именно не скачалось", async () => {
    stubFetch(404, TG_404);
    let msg = "";
    try {
      await fetchTelegramAttachment("https://api.telegram.org/file/botX/y", "документ");
    } catch (e) {
      msg = String((e as Error).message);
    }
    expect(msg).toContain("документ");
    // Ссылка содержит токен бота — её в текст ошибки не кладём.
    expect(msg).not.toContain("botX");
    expect(msg).not.toContain("api.telegram.org");
  });

  test("200 отдаёт тело как есть", async () => {
    stubFetch(200, "содержимое файла");
    const ab = await fetchTelegramAttachment("https://x/y", "документ");
    expect(Buffer.from(ab).toString("utf8")).toBe("содержимое файла");
  });

  test("сигнал таймаута по-прежнему передаётся", async () => {
    const { calls } = stubFetch(200, "ok");
    await fetchTelegramAttachment("https://x/y", "документ");
    expect(calls.length).toBe(1);
    expect(calls[0]!.signal).toBeDefined();
  });

  test("таймаут можно задать явно, по умолчанию — общая константа", async () => {
    const { calls } = stubFetch(200, "ok");
    await fetchTelegramAttachment("https://x/y", "документ", 1);
    expect(calls[0]!.signal).toBeDefined();
  });
});

describe("оба вызова идут через одну проверку", () => {
  const SRC = readFileSync(
    join(import.meta.dir, "..", "orchestrator", "message-handler.ts"),
    "utf8",
  );
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  test("в message-handler.ts не осталось голого arrayBuffer() после fetch", () => {
    // Единственный arrayBuffer — внутри хелпера, сразу за проверкой resp.ok.
    const hits = [...code.matchAll(/arrayBuffer\s*\(\s*\)/g)];
    expect(hits.length).toBe(1);
    const before = code.slice(Math.max(0, hits[0]!.index! - 300), hits[0]!.index!);
    expect(before).toContain("resp.ok");
  });

  test("обе ветки вложений зовут хелпер, а не fetch напрямую", () => {
    for (const marker of [
      "C8: скачиваем картинку",
      // Именно блок скачивания, а не докблок isTextDocument двумястами строк выше.
      "READ_FILE (P1): скачать текстовый файл-вложение",
    ]) {
      const start = SRC.indexOf(marker);
      expect(start).toBeGreaterThan(0);
      const block = SRC.slice(start, start + 3000);
      const upToDownload = block.slice(0, block.indexOf("byteLength"));
      expect(`${marker}: ${upToDownload.includes("fetchTelegramAttachment")}`).toBe(
        `${marker}: true`,
      );
    }
  });
});
