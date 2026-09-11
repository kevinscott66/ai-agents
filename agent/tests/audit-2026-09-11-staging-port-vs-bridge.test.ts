/**
 * Аудит 2026-09-11, круг 30: staging-порт деплоя был портом Mac-моста.
 *
 * `DEFAULT_MAC_BRIDGE_PORT` заведён с докстрокой, которая прямо называет
 * причину его существования: «distinct from the Mini App's 8787 so the bridge
 * can't collide-bind the miniapp port». Правило было сформулировано и тут же
 * нарушено в другом файле: `deploy/staged-deploy.sh` поднимал staging-экземпляр
 * Mini App ровно на 8788.
 *
 * Почему это не теория. Мост живёт в ТОМ ЖЕ процессе, что и Mini App
 * (orchestrator/services.ts зовёт `startMiniappServer`, ниже —
 * `startMacBridge`), оба слушают 127.0.0.1. При заданном `MAC_BRIDGE_SECRET`
 * боевой процесс держит 127.0.0.1:8788, и staging-экземпляр не мог встать на
 * этот адрес НИКОГДА. Причём молча: старт Mini App обёрнут в try/catch и
 * уходит в лог строкой «failed to start», процесс продолжает жить, а
 * `health_check` стучится curl'ом в 8788 — и попадает в мост, который на
 * чужой путь отвечает 403. Скрипт читает это как «staging нездоров» и
 * откатывает исправный билд. Три разных исхода деплоя, и ни один не называет
 * причину.
 *
 * Сторож не сверяет литералы — он держит ПРАВИЛО: три роли, три разных порта.
 * Номера берутся из двух источников правды сразу (константы TS и присваивания
 * в shell), поэтому подвинуть любой из них можно, а столкнуть их — нельзя.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_MAC_BRIDGE_PORT, DEFAULT_MINIAPP_PORT } from "../lib/constants.ts";

const SCRIPT = "../deploy/staged-deploy.sh";

/**
 * Присваивание верхнего уровня из shell-скрипта: `ИМЯ=1234`.
 *
 * Именно с началом строки: `STAGING_PORT` встречается в скрипте и внутри
 * подстановок вида `"$STAGING_PORT"`, и в комментарии-разборе выше. Здесь
 * нужно одно — то место, где значение задано.
 */
function shellPort(name: string): number {
  const src = readFileSync(SCRIPT, "utf8");
  const m = src.match(new RegExp(`^${name}=(\\d+)\\s*$`, "m"));
  if (!m) throw new Error(`${name}= не найдено в ${SCRIPT}`);
  return Number(m[1]);
}

describe("порты деплоя и моста не пересекаются", () => {
  test("staging-порт не равен порту Mac-моста", () => {
    // Ровно тот дефект: совпадение делало staged-деплой невозможным.
    expect(shellPort("STAGING_PORT")).not.toBe(DEFAULT_MAC_BRIDGE_PORT);
  });

  test("staging-порт не равен боевому порту Mini App", () => {
    // Прежний дефект этого же скрипта (аудит 2026-08-12): staging на 8787
    // упирался в занятый боевым процессом порт.
    expect(shellPort("STAGING_PORT")).not.toBe(DEFAULT_MINIAPP_PORT);
  });

  test("боевой порт скрипта — тот же, что дефолт Mini App", () => {
    // Иначе nginx ходит в один порт, а деплой переводит службу в другой.
    expect(shellPort("PROD_PORT")).toBe(DEFAULT_MINIAPP_PORT);
  });

  test("три роли — три разных порта", () => {
    const ports = [
      shellPort("PROD_PORT"),
      shellPort("STAGING_PORT"),
      DEFAULT_MAC_BRIDGE_PORT,
    ];
    expect(new Set(ports).size).toBe(ports.length);
  });
});

describe("сам сторож различает то, ради чего заведён", () => {
  test("порт читается из скрипта, а не подставлен здесь", () => {
    // Сторож, который сверяет две свои же константы, зелен всегда.
    expect(shellPort("PROD_PORT")).toBeGreaterThan(0);
    expect(() => shellPort("НЕТ_ТАКОГО_ПОРТА")).toThrow(/не найдено/);
  });
});
