/**
 * Аудит 2026-08-29: оба blue/green-юнита не смогли бы запуститься, а зелёный
 * вдобавок не поднимался бы после падения, став боевым.
 *
 * 1) Юниты не должны возвращаться к root или к Bun внутри `/root`: такой
 *    процесс получает полный доступ к хосту при компрометации приложения и не
 *    может безопасно включить ProtectHome=true. Выделенный системный аккаунт
 *    и бинарь в `/usr/local/bin` делают обе защиты совместимыми.
 *
 * 2) `Restart=no` у green против `Restart=always` + `RestartSec=5` у blue.
 *    Цвета в staged-deploy.sh не закреплены за ролями: staging-цвет после
 *    health-check'а поднимается на боевом порту и остаётся жить (шаги 4-5
 *    main()). Значит green бывает боевым — и в этой половине циклов прод
 *    после любого падения процесса остаётся лежать, тогда как в другой
 *    половине сам поднимается. `systemctl stop` при `Restart=always`
 *    рестарта не вызывает, так что переключению цветов симметрия не мешает.
 *
 * Тест не поднимает systemd: он читает форму юнитов ровно так, как прочитал бы
 * человек перед `systemctl start`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, "deploy", f), "utf8");

const UNITS = [
  ["blue", read("agent-team-blue.service")],
  ["green", read("agent-team-green.service")],
] as const;

/** Последнее значение директивы (systemd берёт последнее вхождение). */
function directive(unit: string, key: string): string | undefined {
  const all = [...unit.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))];
  return all.length ? all[all.length - 1]![1]!.trim() : undefined;
}

describe("предпосылки", () => {
  for (const [name, unit] of UNITS) {
    test(`${name}: запускается не от root и Bun не лежит в home`, () => {
      const exec = directive(unit, "ExecStart");
      expect(exec).toBeDefined();
      expect(directive(unit, "User")).toBe("agent-team");
      expect(directive(unit, "Group")).toBe("agent-team");
      expect(exec!.split(/\s+/)[0]).toBe("/usr/local/bin/bun");
    });
  }

  test("канонический прод-юнит присутствует и имеет ту же защиту", () => {
    const prod = read("agent-team.service");
    expect(directive(prod, "User")).toBe("agent-team");
    expect(directive(prod, "ExecStart")!.split(/\s+/)[0]).toBe("/usr/local/bin/bun");
    expect(directive(prod, "ProtectHome")).toBe("true");
  });
});

describe("ProtectHome не прячет собственный ExecStart", () => {
  for (const [name, unit] of UNITS) {
    test(`${name}: ProtectHome=true совместим с ExecStart вне home`, () => {
      const exec = directive(unit, "ExecStart")!.split(/\s+/)[0]!;
      const home = directive(unit, "ProtectHome");
      expect(home).toBeDefined();
      expect(exec.startsWith("/root/") || exec.startsWith("/home/")).toBe(false);
      expect(["true", "yes", "on", "1"]).toContain(home!.toLowerCase());
    });

    test(`${name}: остальное ужесточение и закрытая umask на месте`, () => {
      expect(directive(unit, "ProtectSystem")).toBe("strict");
      expect(directive(unit, "NoNewPrivileges")).toBe("true");
      expect(directive(unit, "UMask")).toBe("0077");
    });
  }

  test("оба цвета защищены одинаково", () => {
    expect(directive(UNITS[0][1], "ProtectHome")).toBe(
      directive(UNITS[1][1], "ProtectHome"),
    );
  });
});

describe("перезапуск после падения", () => {
  for (const [name, unit] of UNITS) {
    test(`${name}: боевым может стать любой цвет — значит поднимается сам`, () => {
      expect(directive(unit, "Restart")).toBe("always");
      expect(directive(unit, "RestartSec")).toBe("5");
    });
  }

  test("политика перезапуска у цветов одна", () => {
    for (const key of ["Restart", "RestartSec"]) {
      expect(directive(UNITS[0][1], key)).toBe(directive(UNITS[1][1], key));
    }
  });

  test("staged-deploy действительно оставляет staging-цвет боевым", () => {
    // Иначе про green можно было бы сказать «он всего лишь staging».
    const staged = readFileSync(join(ROOT, "deploy", "staged-deploy.sh"), "utf8");
    expect(staged).toContain("apply_prod_port \"$STAGING_SERVICE\"");
    expect(staged).toContain("systemctl start $STAGING_SERVICE");
  });
});
