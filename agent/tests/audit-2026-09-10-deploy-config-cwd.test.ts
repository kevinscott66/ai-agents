/**
 * Аудит 2026-09-10: `deploy/test-config.sh` работал ровно из одного каталога.
 *
 * Шапка скрипта обещает «can be run locally before deployment», а все пути в
 * нём были относительные: `Caddyfile`, `caddy.service`, `setup-caddy.sh`,
 * `README.md`. Запущенный из корня репозитория — то есть оттуда, откуда в этом
 * проекте запускают всё остальное, и ровно так, как он же сам себя предлагает в
 * README, — он падал на первой проверке: «❌ Caddyfile missing», exit 1.
 *
 * Тихо это потому, что отличить «скрипт не там, где ему надо» от «конфиг
 * действительно сломан» по выводу нельзя: и там и там красный крестик и код 1.
 * Проверка деплойной конфигурации, которая красная всегда, ничего не проверяет —
 * её либо перестают запускать, либо начинают чинить конфиг, с которым всё в
 * порядке.
 *
 * Инвариант: результат скрипта не зависит от текущего каталога. Проверяется
 * поведением — двумя запусками из разных cwd, — а не наличием строки с
 * `BASH_SOURCE`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const SCRIPT = join(REPO, "deploy", "test-config.sh");

function run(cwd: string): { code: number; out: string } {
  const res = Bun.spawnSync({ cmd: ["bash", SCRIPT], cwd });
  return {
    code: res.exitCode,
    out: res.stdout.toString() + res.stderr.toString(),
  };
}

describe("deploy/test-config.sh не зависит от cwd", () => {
  // `caddy` и `systemd-analyze` есть не на всякой машине, и скрипт это сам
  // предусматривает («skipping»). Поэтому проверяем блок поиска файлов — в нём
  // и была поломка, — а не итоговую строку, которая зависит от набора утилит
  // хоста.
  for (const [name, cwd] of [
    ["из корня репозитория", REPO],
    ["из deploy/", join(REPO, "deploy")],
    ["из постороннего каталога", tmpdir()],
  ] as const) {
    test(name, () => {
      const { code, out } = run(cwd);
      expect(out).toContain("✅ Caddyfile exists");
      expect(out).toContain("✅ setup-caddy.sh exists");
      expect(out).not.toContain("missing");
      expect(code).toBe(0);
    });
  }

  test("каталог берётся из пути самого скрипта", () => {
    // Идиома общая с deploy/deploy.sh — если её однажды заменят на
    // `cd deploy` или `cd ..`, поведение выше сломается только на одном из
    // трёх запусков, и лучше сказать об этом прямо.
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"');
    expect(src).toContain('cd "$SCRIPT_DIR"');
  });
});
