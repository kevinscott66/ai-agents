/**
 * Аудит 2026-08-12: blue/green-сценарий деплоя, который в проде не включён, но
 * лежит в репо готовым к запуску — и при запуске ломает ровно то, ради чего
 * написан.
 *
 * Что измерено по файлам репо (git ls-files, без запуска на хосте):
 *
 * 1. `deploy/staged-deploy.sh:147` переписывал юнит-файл НАСОВСЕМ:
 *
 *      sed 's/MINIAPP_PORT=8788/MINIAPP_PORT=8787/' \
 *        /etc/systemd/system/agent-team-green.service > /tmp/…-prod.service
 *      cp /tmp/…-prod.service /etc/systemd/system/agent-team-green.service
 *
 *    После первого же успешного цикла green навсегда объявлен на 8787. А
 *    `get_service_port` в том же скрипте (строки 51-58) продолжает возвращать
 *    для green 8788 — по таблице, не по файлу. Следующий прогон: активен green
 *    (8787), staging = blue (тоже 8787) → `systemctl start blue` упирается в
 *    занятый порт, а health_check стучится в 8788, где уже никого нет. То есть
 *    второй деплой этим скриптом не проходит никогда, и это не «упало и
 *    откатились», а «откат тоже проверяет не тот порт».
 *
 * 2. Оба юнита — `ProtectSystem=strict` + ReadWritePaths только на
 *    `data`, `backups`, `/tmp`. Но `agent/lib/memory.ts:33` пишет вики в
 *    `MEMORY_DIR ?? "memory"` ОТНОСИТЕЛЬНО cwd, а cwd юнита —
 *    `WorkingDirectory=/opt/agent-team`. То же самое написано и в шапке
 *    `deploy/deploy.sh:46-47`, где `memory/` исключён из rsync как рантайм.
 *    Под strict это read-only: любая запись в вики падает на EROFS, а
 *    health-check `/api/health` этого не видит — деплой отчитается успехом.
 *
 * 3. `deploy/test-config.sh` печатал инструкции с адресом `203.0.113.11` —
 *    хоста, с которого прод уехал 2026-06-06 (см. CLAUDE.md §1 и
 *    .claude/memory/notes/server-migration-2026-06-06.md). Инструкция,
 *    выполненная буквально, раскатывает деплой на чужую машину.
 *
 * Проверяем форму файлов: тест не поднимает systemd, он читает то же, что
 * читал бы человек перед запуском скрипта на проде.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8");

const BLUE = read("deploy", "agent-team-blue.service");
const GREEN = read("deploy", "agent-team-green.service");
const STAGED = read("deploy", "staged-deploy.sh");
const TESTCFG = read("deploy", "test-config.sh");

/** Значения ReadWritePaths= из юнита. */
function rwPaths(unit: string): string[] {
  return [...unit.matchAll(/^ReadWritePaths=(.+)$/gm)].map((m) => m[1].trim());
}

/** Значение WorkingDirectory= из юнита. */
function workdir(unit: string): string {
  const m = unit.match(/^WorkingDirectory=(.+)$/m);
  expect(m).not.toBeNull();
  return m![1].trim();
}

describe("blue/green юниты: strict не должен запрещать то, что процесс пишет", () => {
  for (const [name, unit] of [
    ["blue", BLUE],
    ["green", GREEN],
  ] as const) {
    test(`${name}: ProtectSystem=strict и при этом memory/ доступен на запись`, () => {
      // Если strict когда-нибудь уберут — этот тест обязан заметить и
      // потребовать пересмотра, а не молча пройти.
      expect(unit).toContain("ProtectSystem=strict");
      const cwd = workdir(unit);
      const paths = rwPaths(unit);
      // MEMORY_DIR по умолчанию — "memory" относительно cwd юнита.
      expect(paths).toContain(`${cwd}/memory`);
      // Ранее найденное не должно пропасть заодно с правкой.
      expect(paths).toContain(`${cwd}/data`);
      expect(paths).toContain(`${cwd}/backups`);
    });

    test(`${name}: runtime не получает root capabilities и изолирован от host kernel`, () => {
      expect(unit).toContain("NoNewPrivileges=true");
      expect(unit).toContain("CapabilityBoundingSet=\n");
      expect(unit).toContain("AmbientCapabilities=\n");
      expect(unit).toContain("PrivateDevices=true");
      expect(unit).toContain("ProtectKernelModules=true");
      expect(unit).toContain("ProtectKernelLogs=true");
      expect(unit).toContain("ProtectProc=invisible");
      expect(unit).toContain("RestrictNamespaces=true");
      expect(unit).toContain("SystemCallArchitectures=native");
    });
  }

  test("оба цвета работают из одного каталога — значит и пути одни", () => {
    // Общий WorkingDirectory здесь не чинится (это и есть суть blue/green на
    // одном чекауте), но списки ReadWritePaths обязаны совпадать: разойдутся —
    // и деплой «прошёл на blue, упал на green» без единого признака в health.
    expect(workdir(BLUE)).toBe(workdir(GREEN));
    expect(rwPaths(BLUE).sort()).toEqual(rwPaths(GREEN).sort());
  });
});

describe("staged-deploy.sh не портит юнит-файлы", () => {
  test("не переписывает /etc/systemd/system/*.service на месте", () => {
    // Юнит-файл — это описание цвета, а не переменная состояния. Порт
    // переопределяется drop-in'ом, который можно снять.
    expect(STAGED).not.toMatch(/>\s*\/etc\/systemd\/system\/[^\s]*\.service\b/);
    expect(STAGED).not.toMatch(/cp\s+\S+\s+\/etc\/systemd\/system\/[^\s]*\.service\b/);
  });

  test("порт продакшена задаётся drop-in override, и его умеют снимать", () => {
    expect(STAGED).toContain(".service.d");
    expect(STAGED).toMatch(/MINIAPP_PORT=8787/);
    // Снятие обязательно: без него staging при следующем цикле поднимется на
    // боевом порту рядом с живым процессом.
    expect(STAGED).toMatch(/clear_port_override/);
  });

  test("отказывается работать рядом с одноюнитовым продом", () => {
    // Реальный прод — единый agent-team.service (CLAUDE.md §1). Запуск
    // blue/green поверх него даёт два процесса на одной SQLite и одних и тех же
    // токенах ботов: getUpdates у Telegram эксклюзивен, второй потребитель
    // отбирает апдейты у живого.
    expect(STAGED).toContain("agent-team.service");
    expect(STAGED).toMatch(/is-active[^\n]*agent-team\.service|SINGLE_SERVICE/);
  });
});

describe("адреса хостов в deploy/", () => {
  test("нигде не осталось выведенного из строя 203.0.113.11", () => {
    const stale = "38.101" + ".3.46";
    expect(TESTCFG.includes(stale)).toBe(false);
    expect(STAGED.includes(stale)).toBe(false);
  });
});
