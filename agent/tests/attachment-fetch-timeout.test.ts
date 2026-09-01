/**
 * Аудит 2026-08-12: скачивание вложений в message-handler.ts осталось без
 * потолка, хотя соседний путь голосового починили в тот же день.
 *
 *   const link = await bot.telegram.getFileLink(fileId);
 *   const resp = await fetch(link.toString());   // ← ни signal, ни таймаута
 *   const ab   = await resp.arrayBuffer();
 *
 * Два вызова: картинка (:372) и текстовый документ (:407). Оба стоят ПОСЛЕ
 * `sendChatAction("typing")`. Зависший сокет на CDN Telegram (без RST, без
 * FIN) — это промис хендлера, который не завершится никогда: catch рядом не
 * сработает, runWithTools не позовётся, ответа не будет, а в логе не появится
 * ни строки. Пользователь видит «печатает…» вечно, переспрашивает — и
 * запускает второй такой же вечный хендлер. Ровно тот отказ, ради которого
 * в voice-handler.ts завели VOICE_FILE_TIMEOUT_MS; grep по AbortSignal в
 * orchestrator/ находил только его.
 *
 * Второе, из того же места: у картинки нет проверки заявленного размера ДО
 * сети, хотя у документа она есть двумя блоками ниже. `msg.document.file_size`
 * приходит прямо в апдейте и игнорировался — 19-мегабайтный png, присланный
 * документом, целиком тянулся по сети и целиком материализовался в
 * ArrayBuffer, чтобы затем быть отвергнутым проверкой `> 4MB`. Повторяемо
 * кем угодно из аллоулиста, и складывается с первым: платим за скачивание,
 * которое к тому же может зависнуть.
 *
 * Инвариант: ни одного fetch без сигнала в orchestrator/, и обе ветки
 * вложений отсекают по заявленному размеру до выхода в сеть.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  ATTACHMENT_FILE_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  MAX_DOC_BYTES,
} from "../orchestrator/message-handler.ts";

const ORCH_DIR = join(import.meta.dir, "..", "orchestrator");

function orchestratorSources(): { file: string; src: string }[] {
  return readdirSync(ORCH_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: f, src: readFileSync(join(ORCH_DIR, f), "utf8") }));
}

/** Текст вызова fetch до закрывающей скобки — грубо, но достаточно: нас
 *  интересует лишь наличие слова signal в его аргументах. */
function callArgs(src: string, openParen: number): string {
  let depth = 0;
  for (let i = openParen; i < src.length; i++) {
    const c = src[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return src.slice(openParen, i + 1);
    }
  }
  return src.slice(openParen);
}

describe("вложения: скачивание ограничено по времени и по размеру", () => {
  test("ни один fetch в orchestrator/ не уходит без AbortSignal", () => {
    const offenders: string[] = [];
    for (const { file, src } of orchestratorSources()) {
      // Пропускаем комментарии: шапки в этом каталоге цитируют старый код.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of code.matchAll(/\bfetch\s*\(/g)) {
        const call = callArgs(code, m.index! + m[0].length - 1);
        if (!/\bsignal\b/.test(call)) {
          offenders.push(`${file}: ${call.slice(0, 60).replace(/\s+/g, " ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("потолок конечный и в разумных пределах", () => {
    expect(Number.isFinite(ATTACHMENT_FILE_TIMEOUT_MS)).toBe(true);
    expect(ATTACHMENT_FILE_TIMEOUT_MS).toBeGreaterThan(0);
    // Вложение — это мегабайты с CDN, а не выгрузка базы.
    expect(ATTACHMENT_FILE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  test("лимиты размера объявлены константами, а не литералами в двух местах", () => {
    expect(MAX_IMAGE_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_DOC_BYTES).toBe(1024 * 1024);
  });

  test("обе ветки отсекают по заявленному размеру ДО выхода в сеть", () => {
    const src = readFileSync(join(ORCH_DIR, "message-handler.ts"), "utf8");
    for (const [label, marker] of [
      ["картинка", "C8: скачиваем картинку"],
      // Маркер должен быть уникальным: «READ_FILE (P1)» встречается ещё и в
      // докблоке isTextDocument двумястами строк выше, и срез оттуда проверял
      // совсем не тот блок. Тест был зелёным, не проверяя ветку документа.
      ["документ", "READ_FILE (P1): скачать текстовый файл-вложение"],
    ] as const) {
      const start = src.indexOf(marker);
      expect(start).toBeGreaterThan(0);
      const block = src.slice(start, src.indexOf("getFileLink", start));
      // file_size из апдейта должен быть прочитан до getFileLink/fetch.
      expect(`${label}: ${/file_size/.test(block)}`).toBe(`${label}: true`);
    }
  });
});
