/**
 * Аудит 2026-09-11: шапка lib/watchdog.ts обещала не то поведение, которое
 * в этом же дереве пришпилено тестом.
 *
 * Она говорила: «если за `silenceMs` от какого-то бота не было ни одного [raw]
 * апдейта — алертим в чат через `alert`». В коде чат-алёрт получают ТОЛЬКО
 * ключи из `chatAlertKeys` (по умолчанию один `orchestrator`), остальным идёт
 * `log.debug` — и ровно это пришпилено в c7.test.ts («chat-alert ТОЛЬКО для
 * chatAlertKeys»). То есть поведение защищено, врала одна шапка — а читают её
 * раньше, чем тест: следующий, кто заведёт роль-бота, по ней решит, что тишина
 * дизайнера разбудит владельца.
 *
 * Заодно ушёл призрак «[raw] апдейта»: хендлера с таким именем нет с аудита
 * 2026-08-28, отметку ставит middleware `registerSeenProbe` на любой апдейт.
 *
 * Сторож узкий: он не пересказывает поведение (это дело c7.test.ts), а следит
 * за тем, чтобы шапка называла развилку и не воскрешала мёртвое имя.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(import.meta.dir, "..", "lib", "watchdog.ts"), "utf8");
const HEADER = SRC.slice(0, SRC.indexOf("*/") + 2);

describe("шапка watchdog описывает то, что делает watchdog", () => {
  test("развилка chatAlertKeys названа в шапке", () => {
    expect(HEADER).toContain("chatAlertKeys");
  });

  test("шапка не воскрешает призрачный [raw]-хендлер как источник отметки", () => {
    // Имя может упоминаться только как надгробие — рядом со словом о том, что
    // его больше нет. Утверждения «не было ни одного [raw] апдейта» быть не
    // должно.
    expect(HEADER).not.toContain("ни одного [raw]");
  });

  test("шапка называет настоящий источник отметки", () => {
    expect(HEADER).toContain("registerSeenProbe");
    expect(SRC).toContain("export function registerSeenProbe");
  });

  test("комментарий про synchronous throw не шлёт читателя вниз за `.catch`", () => {
    // Сторож на направление, а не на формулировку: `.catch` в чат-ветке стоит
    // ВЫШЕ комментария у setInterval, и слово «ниже» уводило читателя в конец
    // файла, где ловушки нет вовсе — её ставит `safeTick`.
    const comment = SRC.indexOf("`alert` приходит снаружи");
    const cat = SRC.indexOf("alert(msg).catch(");
    expect(comment).toBeGreaterThan(0);
    expect(cat).toBeGreaterThan(0);
    expect(cat).toBeLessThan(comment);
    expect(SRC.slice(comment, comment + 400)).toContain("safeTick");
  });
});
