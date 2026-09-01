/**
 * Аудит 2026-08-29 — путь через Caddy (альтернатива боевому nginx :8443).
 *
 * Четыре независимых дефекта, каждый из которых в одиночку делает этот путь
 * неработающим, а вместе они дают ложное ощущение готовности:
 *
 * 1. `systemctl enable caddy` стоял ДО `caddy validate`. Битый конфиг → скрипт
 *    выходит 1, но юнит уже в автозапуске: после первого ребута хост полез бы
 *    за :80/:443, а :443 здесь занят сторонним xray VPN (CLAUDE.md §1).
 * 2. Скрипт клал конфиг в /etc/caddy/Caddyfile и валидировал ЕГО, а юнит
 *    запускался с --config /opt/agent-team/deploy/Caddyfile. Проверяли один
 *    файл, исполняли другой. Хуже: deploy/deploy.sh синхронизирует только
 *    agent/ → /opt/agent-team/, то есть каталога deploy/ там просто нет —
 *    и источник копирования в скрипте указывал туда же.
 * 3. `caddy run --environ` печатает всё окружение процесса в журнал при каждом
 *    старте. Для юнита, который завтра может получить EnvironmentFile, это
 *    заготовленная утечка, а сегодня — просто шум.
 * 4. Сам Caddyfile не прошёл бы `caddy validate`: `header` не является
 *    глобальной опцией; `keepalive`/`dial_timeout` — субдирективы
 *    `transport http`, а не `reverse_proxy`; `read_timeout`/`write_timeout`
 *    там не существуют вовсе; `rate_limit` — сторонний плагин, которого нет в
 *    пакете из cloudsmith-репозитория, тот самый, что ставит этот скрипт.
 *
 * caddy здесь не запускается: тесты читают файлы. `caddy validate` прогнать
 * негде — бинаря на Mac нет, поэтому проверяются структурные инварианты
 * синтаксиса Caddy v2, а не вердикт валидатора.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEPLOY = join(import.meta.dir, "..", "..", "deploy");
const read = (f: string) => readFileSync(join(DEPLOY, f), "utf8");

const UNIT = read("caddy.service");
const SETUP = read("setup-caddy.sh");
const CADDYFILE = read("Caddyfile");

/** Строки конфига без комментариев — «нет директивы» ищем только в коде. */
function configLines(src: string): string[] {
  return src
    .split("\n")
    .map((l) => l.replace(/\s+#\s.*$/, ""))
    .filter((l) => !l.trimStart().startsWith("#"));
}

/** Блок от строки со стартовым `{` до парной `}`, по балансу скобок. */
function blockAfter(lines: string[], startIdx: number): string[] {
  let depth = 0;
  const out: string[] = [];
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    depth += (line.match(/\{/g) ?? []).length;
    depth -= (line.match(/\}/g) ?? []).length;
    out.push(line);
    if (depth <= 0 && i > startIdx) break;
    if (depth === 0 && i === startIdx) break;
  }
  return out;
}

/** Юнит без комментариев: его собственная шапка цитирует и --environ, и старый путь. */
const UNIT_CODE = configLines(UNIT).join("\n");

const unitDirective = (key: string) =>
  [...UNIT.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].pop()?.[1] ?? "";

const configPathOf = (execLine: string) => /--config\s+(\S+)/.exec(execLine)?.[1] ?? "";

describe("caddy.service", () => {
  test("--environ не печатает окружение в журнал при каждом старте", () => {
    expect(unitDirective("ExecStart")).not.toContain("--environ");
    expect(UNIT_CODE).not.toContain("--environ");
  });

  test("ExecStart и ExecReload читают ОДИН конфиг", () => {
    const start = configPathOf(unitDirective("ExecStart"));
    const reload = configPathOf(unitDirective("ExecReload"));
    expect(start).not.toBe("");
    expect(start).toBe(reload);
  });

  test("конфиг берётся из /etc/caddy — туда его кладёт и там же проверяет setup-caddy.sh", () => {
    expect(configPathOf(unitDirective("ExecStart"))).toBe("/etc/caddy/Caddyfile");
  });

  test("юнит не ссылается на /opt/agent-team/deploy — deploy.sh туда ничего не кладёт", () => {
    expect(UNIT_CODE).not.toContain("/opt/agent-team/deploy");
  });
});

describe("setup-caddy.sh", () => {
  // Только код: комментарии в этом же файле цитируют и «systemctl enable caddy»,
  // и историю аудита — по ним порядок выполнения не определяют.
  const lines = configLines(SETUP);
  const code = lines.join("\n");
  const lineOf = (needle: string) => lines.findIndex((l) => l.includes(needle));

  test("валидация конфига идёт ДО systemctl enable", () => {
    const validate = lineOf("caddy validate");
    const enable = lineOf("systemctl enable caddy");
    expect(validate).toBeGreaterThanOrEqual(0);
    expect(enable).toBeGreaterThanOrEqual(0);
    expect(validate).toBeLessThan(enable);
  });

  test("валидируется ровно тот файл, который запускает юнит", () => {
    // Путь задан один раз переменной — сравниваем её значение, а не текст.
    const dest = /^CADDYFILE_DEST="([^"]+)"/m.exec(code)?.[1] ?? "";
    expect(dest).toBe(configPathOf(unitDirective("ExecStart")));
    expect(code).toContain('caddy validate --config "$CADDYFILE_DEST"');
    // Копирование идёт туда же, куда и валидация.
    expect(code).toContain('cp "$SCRIPT_DIR/Caddyfile" "$CADDYFILE_DEST"');
  });

  test("источник копирования — каталог самого скрипта, а не несуществующий /opt/agent-team/deploy", () => {
    expect(code).toContain("SCRIPT_DIR");
    expect(code).not.toContain("cp /opt/agent-team/deploy/");
  });

  test("отсутствие исходных файлов — отказ, а не cp с пустым результатом", () => {
    expect(code).toContain("$SCRIPT_DIR/Caddyfile");
    expect(code).toContain("$SCRIPT_DIR/caddy.service");
    expect(code).toMatch(/if \[\[ ! -f "\$SCRIPT_DIR\//);
  });

  test("порты 80/443 по-прежнему проверяются до enable (регрессия аудита 2026-08-12)", () => {
    const port443 = lineOf("порт 443 уже занят");
    const enable = lineOf("systemctl enable caddy");
    expect(port443).toBeGreaterThanOrEqual(0);
    expect(port443).toBeLessThan(enable);
  });
});

describe("Caddyfile — структурные инварианты синтаксиса Caddy v2", () => {
  const lines = configLines(CADDYFILE);

  test("глобальный блок не содержит header — это директива сайта, а не опция", () => {
    const start = lines.findIndex((l) => l.trim() === "{");
    expect(start).toBeGreaterThanOrEqual(0);
    const global = blockAfter(lines, start);
    expect(global.some((l) => /^\s*header\b/.test(l))).toBe(false);
  });

  test("keepalive и dial_timeout лежат в transport http, а не прямо в reverse_proxy", () => {
    const rpIdx = lines.findIndex((l) => l.includes("reverse_proxy"));
    expect(rpIdx).toBeGreaterThanOrEqual(0);
    const rp = blockAfter(lines, rpIdx);
    const trIdx = rp.findIndex((l) => /transport\s+http/.test(l));
    expect(trIdx).toBeGreaterThanOrEqual(0);
    const transport = blockAfter(rp, trIdx).join("\n");
    for (const d of ["keepalive", "keepalive_idle_conns", "dial_timeout"]) {
      expect(transport).toContain(d);
    }
    // Прямо в reverse_proxy их быть не должно.
    const outsideTransport = rp.filter((_, i) => i < trIdx).join("\n");
    for (const d of ["keepalive", "dial_timeout"]) {
      expect(outsideTransport).not.toContain(d);
    }
  });

  test("read_timeout / write_timeout убраны — их нет ни в reverse_proxy, ни в transport http", () => {
    const code = lines.join("\n");
    expect(code).not.toContain("read_timeout");
    expect(code).not.toContain("write_timeout");
  });

  test("rate_limit убран — это сторонний плагин, которого нет в пакете из cloudsmith", () => {
    expect(lines.join("\n")).not.toContain("rate_limit");
    // Почему убран — должно быть написано, иначе вернут обратно.
    expect(CADDYFILE).toContain("xcaddy");
  });

  test("несуществующий X-Frame-Options ALLOWALL заменён на frame-ancestors в CSP", () => {
    const code = lines.join("\n");
    expect(code).not.toContain("ALLOWALL");
    expect(code).not.toMatch(/^\s*X-Frame-Options\b/m);
    expect(code).toContain("frame-ancestors");
    expect(code).toContain("web.telegram.org");
  });

  test("проксирование на локальный agent-team не изменилось", () => {
    expect(lines.join("\n")).toContain("reverse_proxy localhost:8787");
    expect(lines.join("\n")).toContain("agents.example.com");
  });
});
