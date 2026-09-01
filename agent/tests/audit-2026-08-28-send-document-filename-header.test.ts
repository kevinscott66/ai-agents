/**
 * Аудит 2026-08-28: из имени файла вычищались только разделители пути.
 *
 * `filename` у SEND_DOCUMENT — обязательный аргумент модели (tools-schema.ts:
 * «имя файла (с расширением)»), то есть его форму задаёт текст чата или имя
 * входящего вложения. Санитайзер убирал `/` и `\`, а кавычку и перевод строки
 * оставлял.
 *
 * Дальше имя идёт нетронутым: `tgSendDocument` кладёт его в
 * `{ source, filename }` как есть, telegraf подставляет его в заголовок части
 * СЫРЫМ (`filename="${fileName}"`, client.js:200 и :220), а `addPart` пишет
 * `${key}:${header}` с CRLF и без экранирования (multipart-stream.js:41-46).
 * Значит имя вида `a.txt"<CRLF>Content-Type: text/html<CRLF><CRLF>…` объявляет
 * части чужой тип, а одна кавычка обрывает имя у строгих парсеров.
 *
 * Границу части подделать нельзя — она из 32 случайных байт, — так что дальше
 * заголовков одной части это не уходит. Но и этого достаточно, а починка — одна
 * строка.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildPayload } from "../lib/dispatch/build-payload.ts";

const CTX = { agentKey: "qa" };

function name(filename: string, content = "hello"): string {
  const r = buildPayload("SEND_DOCUMENT" as never, { content, filename } as never, CTX) as
    | { ok: true; payload: { filename: string } }
    | { ok: false; error: string };
  if (!r.ok) throw new Error(`отказ: ${r.error}`);
  return r.payload.filename;
}

/** Ровно то, что ломает заголовок части: кавычка, CR/LF, управляющие, DEL. */
const HOSTILE = /["\u0000-\u001f\u007f]/;

describe("имя файла не может дописать заголовок части", () => {
  test("CRLF с подменой content-type не доезжает", () => {
    const out = name('a.txt"\r\nContent-Type: text/html\r\n\r\n<script>x</script>');
    expect(out).not.toMatch(HOSTILE);
    expect(out).not.toContain('"');
  });

  test("одиночная кавычка не обрывает имя", () => {
    expect(name('a"b.txt')).not.toContain('"');
  });

  test("голый перевод строки и возврат каретки убираются оба", () => {
    expect(name("a\nb\rc.txt")).not.toMatch(HOSTILE);
  });

  test("управляющие символы и DEL убираются", () => {
    expect(name("a\u0000b\u001bc\u007fd.txt")).not.toMatch(HOSTILE);
  });

  test("разделители пути по-прежнему убираются", () => {
    expect(name("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(name("a\\b.txt")).toBe("a_b.txt");
  });

  test("никакой мыслимый вход не оставляет опасного символа", () => {
    const inputs = [
      'x"; name="chat_id"; x="',
      "x\r\n\r\nтело",
      "\u0001\u001f.txt",
      '"'.repeat(50),
      `${"a".repeat(300)}"\r\n`,
    ];
    for (const raw of inputs) expect(name(raw)).not.toMatch(HOSTILE);
  });
});

describe("обычные имена не портятся", () => {
  test("латиница, цифры, точки, дефисы и подчёркивания как были", () => {
    for (const ok of ["report.md", "a-b_c.v2.txt", "2026-08-28.json", "SUMMARY (1).txt"]) {
      expect(name(ok)).toBe(ok);
    }
  });

  test("кириллица и пробелы остаются", () => {
    expect(name("отчёт за неделю.md")).toBe("отчёт за неделю.md");
  });

  test("обрамляющие пробелы снимаются, как и раньше", () => {
    expect(name("  report.md  ")).toBe("report.md");
  });
});

describe("остальные проверки SEND_DOCUMENT не сдвинулись", () => {
  test("потолок в 200 символов на месте", () => {
    expect(name(`${"a".repeat(300)}.txt`).length).toBe(200);
  });

  test("пустое имя и пустое содержимое — прежние отказы", () => {
    const empty = buildPayload(
      "SEND_DOCUMENT" as never,
      { content: "x", filename: "   " } as never,
      CTX,
    ) as { ok: false; error: string };
    expect(empty).toEqual({ ok: false, error: "filename is required" });

    const noContent = buildPayload(
      "SEND_DOCUMENT" as never,
      { content: "", filename: "a.txt" } as never,
      CTX,
    ) as { ok: false; error: string };
    expect(noContent).toEqual({ ok: false, error: "content is required" });
  });

  test("имя из одних опасных символов не отказ, но и не опасно", () => {
    // trim() кавычки не снимает, значит отказа не будет — важно, чтобы то, что
    // осталось, было безобидно.
    expect(name('"""')).not.toMatch(HOSTILE);
  });

  test("потолок в 2 МБ на месте", () => {
    const big = buildPayload(
      "SEND_DOCUMENT" as never,
      { content: "a".repeat(2_000_001), filename: "a.txt" } as never,
      CTX,
    ) as { ok: false; error: string };
    expect(big).toEqual({ ok: false, error: "content too large (>2MB)" });
  });
});

describe("предпосылки", () => {
  test("telegraf кладёт имя в заголовок части без экранирования", () => {
    // Если это когда-нибудь перестанет быть правдой, чистку можно ослабить —
    // но узнать об этом нужно от теста, а не от Telegram.
    const client = readFileSync(
      new URL("../node_modules/telegraf/lib/core/network/client.js", import.meta.url),
      "utf-8",
    );
    expect(client).toContain('filename="${fileName}"');
  });

  test("отправка имя не чистит — вся чистка обязана быть в сборке payload", () => {
    const actions = readFileSync(new URL("../lib/telegram-actions.ts", import.meta.url), "utf-8");
    expect(actions).toContain("filename: args.filename");
  });
});
