/**
 * Аудит 2026-08-29 по каталогу `agent/mac-daemon/**`.
 *
 * 1. `CLAUDE_BIN` читался как `process.env.CLAUDE_BIN ?? "claude"`. В
 *    `.env.example` эта переменная отгружается пустой («Пусто = ищется в
 *    PATH»), а `??` пустую строку пропускает. Дальше `Bun.spawn` с пустым
 *    argv[0] бросает, и КАЖДЫЙ прогон отвечает `spawn_failed` — при живом
 *    сокете и бодром стартовом логе. `MAC_RUN_CLAUDE` — единственный путь
 *    команды из 12 ролей к Mac и дизайн-скиллам, то есть отключается он
 *    целиком. Класс известный: `EnvironmentFile=` в systemd отдаёт `KEY=`
 *    пустой строкой, а не `undefined` (CLAUDE.md, `_resolveBridgeHost`).
 *
 * 2. Подсказка при старте называла порт 8787 — это HTTP-порт Mini App.
 *    Мост слушает 8788. По такой подсказке демон стучится в панель, где
 *    WS-апгрейда нет, и уходит в вечный реконнект.
 *
 * 3. Раздел «Безопасность Stage B» в README описывал механизм, которого в
 *    коде нет: режим якобы уходит переменной `CLAUDE_PERMISSION_MODE` (на
 *    деле — флагом `--permission-mode`, а такую переменную `sanitizeChildEnv`
 *    всё равно вырезала бы), и режимов якобы пять к пяти (на деле пять к
 *    четырём: `auto` — синоним `accept_edits`). Читающий README выбирает
 *    `auto`, считая его уровнем «без спроса, но без MAC_ALLOW_BYPASS».
 *
 * 4. Ссылки на номера строк в комментариях протухли (`mac-bridge.ts:141`,
 *    `dispatch/mac.ts:130`, `tools-schema.ts:1175`). Первая опаснее прочих:
 *    из `PING_INTERVAL_MS` выведен `STALE_MS` watchdog'а, а строка 141 — это
 *    середина `_envIntInRange`, то есть ссылка выглядит протухшей целиком и
 *    связь двух констант теряется.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveClaudeBin, sanitizeChildEnv } from "../mac-daemon/child-env.ts";
import { toPermissionMode, RUN_MODES } from "../mac-daemon/protocol.ts";
import { DEFAULT_MAC_BRIDGE_PORT } from "../lib/constants.ts";

const DAEMON_DIR = new URL("../mac-daemon/", import.meta.url).pathname;
const read = (name: string) => readFileSync(join(DAEMON_DIR, name), "utf-8");
const DAEMON = read("daemon.ts");
const README = read("README.md");

function codeLines(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trimStart();
    return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
  });
}
const DAEMON_CODE = codeLines(DAEMON);
const daemonHas = (needle: string) => DAEMON_CODE.some((l) => l.includes(needle));

describe("предпосылки", () => {
  test("пустой argv[0] не запускает ничего, а бросает", () => {
    // Именно поэтому пустая строка обязана не доехать до spawn.
    expect(() => Bun.spawnSync({ cmd: [""] })).toThrow();
  });
});

describe("resolveClaudeBin", () => {
  test("пусто и пробельное — дефолт", () => {
    for (const raw of ["", " ", "\t", "\n"]) {
      expect(resolveClaudeBin({ CLAUDE_BIN: raw })).toBe("claude");
    }
  });

  test("переменной нет — дефолт", () => {
    expect(resolveClaudeBin({})).toBe("claude");
    expect(resolveClaudeBin({ CLAUDE_BIN: undefined })).toBe("claude");
  });

  test("настоящий путь проходит как есть", () => {
    expect(resolveClaudeBin({ CLAUDE_BIN: "/opt/homebrew/bin/claude" })).toBe(
      "/opt/homebrew/bin/claude",
    );
  });

  test("путь со значащим пробелом не тримится", () => {
    // Отсекаем только целиком пробельное значение, а не пробелы в пути.
    const p = "/Volumes/My Disk/claude";
    expect(resolveClaudeBin({ CLAUDE_BIN: p })).toBe(p);
  });

  test("демон читает через санитайзер, а не через ??", () => {
    expect(daemonHas("resolveClaudeBin(process.env)")).toBe(true);
    expect(daemonHas("process.env.CLAUDE_BIN")).toBe(false);
  });

  test("CLAUDE_BIN в окружение ребёнка не попадает", () => {
    // Путь до бинаря — аргумент spawn, не наследуемая переменная.
    expect(sanitizeChildEnv({ CLAUDE_BIN: "/x/claude", PATH: "/usr/bin" })).toEqual({
      PATH: "/usr/bin",
    });
  });
});

describe("подсказка про MAC_BRIDGE_URL", () => {
  test("называет порт моста, а не порт Mini App", () => {
    expect(DEFAULT_MAC_BRIDGE_PORT).toBe(8788);
    expect(daemonHas("wss://host:${DEFAULT_MAC_BRIDGE_PORT}")).toBe(true);
    expect(DAEMON_CODE.some((l) => l.includes("wss://host:8787"))).toBe(false);
  });
});

describe("README не расходится с кодом", () => {
  test("режим уходит флагом CLI, а не переменной окружения", () => {
    expect(README).not.toContain("CLAUDE_PERMISSION_MODE");
    expect(README).toContain("--permission-mode");
    expect(daemonHas("--permission-mode")).toBe(true);
  });

  test("каждое отображение режима из кода описано в README", () => {
    for (const mode of RUN_MODES) {
      expect(README).toContain(`\`${mode}\`→\`${toPermissionMode(mode)}\``);
    }
  });

  test("auto не подаётся как обход MAC_ALLOW_BYPASS", () => {
    expect(toPermissionMode("auto")).toBe("acceptEdits");
    expect(toPermissionMode("auto")).not.toBe("bypassPermissions");
  });

  test("остановка описана целиком, вместе с эскалацией", () => {
    expect(README).toContain("SIGKILL");
  });
});

describe("ссылки на номера строк", () => {
  test("в mac-daemon/** их не осталось", () => {
    const offenders: string[] = [];
    for (const name of readdirSync(DAEMON_DIR)) {
      if (!/\.(ts|md)$/.test(name)) continue;
      for (const l of read(name).split("\n")) {
        if (/\.ts:\d/.test(l)) offenders.push(`${name}: ${l.trim().slice(0, 90)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("self-diag называет символы вместо строк", () => {
    const src = readFileSync(new URL("../lib/self-diag.ts", import.meta.url), "utf-8");
    const bullet = src.split("\n").filter((l) => l.includes("allow-list Mac-моста"));
    expect(bullet.length).toBe(1);
    expect(bullet[0]).toContain("isUserAllowed");
    expect(bullet[0]).not.toMatch(/mac\.ts:\d/);
  });
});
