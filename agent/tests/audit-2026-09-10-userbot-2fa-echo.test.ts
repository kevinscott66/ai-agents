/**
 * Аудит 2026-09-10: приглашение к вводу облачного пароля 2FA обещало «не
 * покажется», а печатало его целиком.
 *
 * `tools/userbot-login.ts` спрашивал пароль тем же `rl.question` с обычным
 * `output`, что и SMS-код, — то есть readline рисовал каждый нажатый символ.
 * Пароль оставался на экране и в скроллбэке терминала; на macOS скроллбэк
 * переживает закрытие вкладки. Это единственный секрет во всём репозитории,
 * который вводит человек и которого нет ни в `.env`, ни в `agent/data`: он
 * открывает аккаунт Telegram владельца целиком, а не сессию userbot'а, и в
 * ротацию секретов не входит.
 *
 * Отдельно вредна была именно связка с текстом приглашения: человек не следит
 * за экраном, набирая то, что ему пообещали скрыть.
 *
 * Тест держит обе стороны: пароль не попадает в вывод — и он всё-таки
 * прочитан правильно (глушилка не должна ломать ввод). Контрольная ветка
 * показывает, что при том же терминальном режиме обычный интерфейс эхо даёт,
 * то есть проверяется не тавтология.
 */
import { describe, expect, test } from "bun:test";
import * as readline from "node:readline/promises";
import { PassThrough, Writable } from "node:stream";
import { askHidden } from "../tools/userbot-login.ts";

const SECRET = "correct-horse-battery";

/** stdin-подобный поток: readline при `terminal: true` зовёт setRawMode. */
function fakeTty(line: string): PassThrough {
  const stream = new PassThrough();
  (stream as unknown as { isTTY: boolean }).isTTY = true;
  (stream as unknown as { setRawMode: (v: boolean) => void }).setRawMode = () => {};
  // Посимвольно — так же, как приходит настоящий ввод в raw-режиме.
  queueMicrotask(() => {
    for (const ch of line) stream.write(ch);
    stream.write("\r");
  });
  return stream;
}

function capture(): { out: Writable; text: () => string } {
  let text = "";
  const out = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  return { out, text: () => text };
}

describe("облачный пароль 2FA", () => {
  test("не попадает в вывод, но читается целиком", async () => {
    const { out, text } = capture();
    const prompt = "[userbot-login] облачный пароль (2FA, не покажется): ";
    const got = await askHidden(prompt, { input: fakeTty(SECRET), output: out });

    expect(got).toBe(SECRET);
    expect(text()).toContain(prompt);
    expect(text()).not.toContain(SECRET);
    // И ни одного символа пароля по отдельности сверх самого приглашения.
    expect(text().replace(prompt, "").trim()).toBe("");
  });

  test("контроль: обычный интерфейс в том же режиме эхо печатает", async () => {
    const { out, text } = capture();
    const rl = readline.createInterface({
      input: fakeTty(SECRET),
      output: out,
      terminal: true,
    });
    const got = (await rl.question("")).trim();
    rl.close();

    expect(got).toBe(SECRET);
    expect(text()).toContain(SECRET);
  });

  test("боевые вызовы шов не используют", async () => {
    const src = await Bun.file(
      new URL("../tools/userbot-login.ts", import.meta.url),
    ).text();
    expect(src).toContain(
      'askHidden("[userbot-login] облачный пароль (2FA, не покажется): ")',
    );
    // Пароль не должен вернуться к общему `rl` при следующей правке.
    expect(src).not.toMatch(/password: async \(\) => \{[\s\S]*?rl\.question/);
  });
});
