/**
 * Аудит 2026-08-28: ответ на сообщение терялся у всего, что уходит файлом.
 *
 * `tgSendPhoto` (Buffer-источник) и `tgSendDocument` клали в extra объект
 * `reply_parameters: { message_id }`. Сериализатор telegraf знает список полей,
 * которые на multipart-пути надо превратить в JSON-строку
 * (`FORM_DATA_JSON_FIELDS` = results, reply_markup, mask_position,
 * shipping_options, errors). `reply_parameters` появился в Bot API 7.0 позже и
 * в этот список не попал: незнакомый объект уезжает в `attachFormMedia`, тот
 * ищет в нём `url` или `source`, не находит ни того ни другого и возвращается,
 * **не вызвав `form.addPart`**. Поле не попадает в тело запроса вовсе.
 *
 * Ответ при этом `ok:true` — отправка считается успешной, а сообщение уходит
 * самостоятельным, вне ветки. Заметнее всего на SEND_DOCUMENT с длинной
 * подписью: сам документ вне ветки, а хвост подписи (он идёт через sendMessage,
 * то есть JSON) — аккуратным ответом на него.
 *
 * Проверяем на живом сериализаторе telegraf: apiRoot смотрит в локальный
 * http-сервер, и тесты читают ровно те байты, которые ушли бы в Telegram.
 * Прежний тест на эту тему (send-document-caption-parse-mode.test.ts) смотрел
 * на `extra` в самодельной заглушке — то есть ДО сериализатора, где поле ещё
 * на месте, — и потому давал ложную уверенность.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Telegram } from "telegraf";
import { tgSendDocument, tgSendMessage, tgSendPhoto } from "../lib/telegram-actions.ts";

interface Wire {
  path: string;
  contentType: string;
  body: string;
}

const servers: http.Server[] = [];
let wire: Wire[] = [];
let tg: Telegram;

async function startApi(): Promise<Telegram> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      wire.push({
        path: req.url ?? "",
        contentType: String(req.headers["content-type"] ?? ""),
        // latin1: тело multipart содержит сырые байты файла, а нам нужны
        // границы и текстовые части — utf8 их бы покорёжил.
        body: Buffer.concat(chunks).toString("latin1"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { message_id: wire.length } }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return new Telegram("123:TEST", { apiRoot: `http://127.0.0.1:${port}` });
}

tg = await startApi();

afterAll(() => {
  for (const s of servers) {
    (s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    s.close();
  }
});

beforeEach(() => {
  wire = [];
});

/** Части multipart-тела по имени поля; вложения-файлы пропускаем. */
function fields(w: Wire): Record<string, string> {
  const b = /boundary=(?:"([^"]+)"|([^;]+))/.exec(w.contentType);
  const boundary = `--${(b?.[1] ?? b?.[2] ?? "").trim()}`;
  const out: Record<string, string> = {};
  for (const chunk of w.body.split(boundary)) {
    const i = chunk.indexOf("\r\n\r\n");
    if (i < 0) continue;
    const head = chunk.slice(0, i);
    if (/filename=/.test(head)) continue;
    const nm = /(?:^|;)\s*name="([^"]+)"/m.exec(head);
    if (nm) out[nm[1]!] = chunk.slice(i + 4).replace(/\r\n$/, "");
  }
  return out;
}

const isMultipart = (w: Wire) => w.contentType.startsWith("multipart/form-data");
/** Тело читается как latin1, поэтому и ожидание переводим в те же байты. */
const l1 = (s: string) => Buffer.from(s, "utf8").toString("latin1");
const json = (w: Wire) => JSON.parse(w.body) as Record<string, unknown>;
const png = () => ({ buffer: Buffer.from("PNGDATA"), filename: "i.png" });

describe("предпосылки", () => {
  test("telegraf молча выбрасывает объект reply_parameters из multipart", async () => {
    // Ровно тот вызов, который делал наш код до правки. Ошибки нет, ok:true.
    await tg.sendPhoto(1, { source: Buffer.from("X"), filename: "x.png" } as never, {
      reply_parameters: { message_id: 42 },
    } as never);
    expect(isMultipart(wire[0]!)).toBe(true);
    expect(fields(wire[0]!).reply_parameters).toBeUndefined();
    expect(wire[0]!.body).not.toContain("reply_parameters");
  });

  test("на JSON-пути тот же объект доезжает — отсюда и асимметрия", async () => {
    await tg.sendMessage(1, "t", { reply_parameters: { message_id: 42 } } as never);
    expect(isMultipart(wire[0]!)).toBe(false);
    expect(json(wire[0]!).reply_parameters).toEqual({ message_id: 42 });
  });
});

describe("tgSendPhoto из буфера", () => {
  test("ответ доезжает до провода", async () => {
    await tgSendPhoto(tg, { chatId: 5, photo: png(), replyToMessageId: 42 });
    expect(isMultipart(wire[0]!)).toBe(true);
    expect(fields(wire[0]!).reply_parameters).toBe('{"message_id":42}');
  });

  test("с подписью — тоже", async () => {
    await tgSendPhoto(tg, { chatId: 5, photo: png(), caption: "подпись", replyToMessageId: 42 });
    expect(fields(wire[0]!).reply_parameters).toBe('{"message_id":42}');
    expect(fields(wire[0]!).caption).toContain(l1("подпись"));
  });

  test("без replyToMessageId поля нет вовсе", async () => {
    await tgSendPhoto(tg, { chatId: 5, photo: png() });
    expect(wire[0]!.body).not.toContain("reply_parameters");
  });
});

describe("tgSendPhoto по URL", () => {
  test("это JSON-путь: там объект, а не строка", async () => {
    await tgSendPhoto(tg, {
      chatId: 5,
      photo: { url: "https://example.test/a.png" },
      replyToMessageId: 42,
    });
    expect(isMultipart(wire[0]!)).toBe(false);
    // Строка здесь доехала бы строкой — Bot API получил бы не объект.
    expect(json(wire[0]!).reply_parameters).toEqual({ message_id: 42 });
  });
});

describe("tgSendDocument", () => {
  test("ответ доезжает до провода", async () => {
    await tgSendDocument(tg, {
      chatId: 5,
      content: "тело",
      filename: "d.txt",
      replyToMessageId: 42,
    });
    expect(isMultipart(wire[0]!)).toBe(true);
    expect(fields(wire[0]!).reply_parameters).toBe('{"message_id":42}');
  });

  test("с подписью — тоже", async () => {
    await tgSendDocument(tg, {
      chatId: 5,
      content: "тело",
      filename: "d.txt",
      caption: "подпись",
      replyToMessageId: 42,
    });
    expect(fields(wire[0]!).reply_parameters).toBe('{"message_id":42}');
  });

  test("без replyToMessageId поля нет вовсе", async () => {
    await tgSendDocument(tg, { chatId: 5, content: "тело", filename: "d.txt" });
    expect(wire[0]!.body).not.toContain("reply_parameters");
  });

  test("документ и хвост подписи ветвятся согласованно", async () => {
    // Тот самый разрыв: документ уходил вне ветки, а хвост — ответом на него.
    const long = "п".repeat(1200);
    await tgSendDocument(tg, {
      chatId: 5,
      content: "тело",
      filename: "d.txt",
      caption: long,
      replyToMessageId: 42,
    });
    expect(wire.length).toBeGreaterThan(1);
    expect(fields(wire[0]!).reply_parameters).toBe('{"message_id":42}');
    // Хвост — sendMessage, JSON-путь, ответ на сам документ.
    const tail = wire[1]!;
    expect(isMultipart(tail)).toBe(false);
    expect(json(tail).reply_parameters).toEqual({ message_id: 1 });
  });
});

describe("tgSendMessage", () => {
  test("JSON-путь не изменился: объект", async () => {
    await tgSendMessage(tg, { chatId: 5, text: "t", replyToMessageId: 42 });
    expect(isMultipart(wire[0]!)).toBe(false);
    expect(json(wire[0]!).reply_parameters).toEqual({ message_id: 42 });
  });

  test("без replyToMessageId поля нет", async () => {
    await tgSendMessage(tg, { chatId: 5, text: "t" });
    expect(json(wire[0]!).reply_parameters).toBeUndefined();
  });
});
