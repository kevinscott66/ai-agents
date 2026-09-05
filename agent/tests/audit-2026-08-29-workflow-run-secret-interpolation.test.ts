/**
 * Аудит 2026-08-29 — значения секретов подставляются прямо в текст shell-команды.
 *
 * `${{ secrets.X }}` внутри `run:` — это НЕ переменная окружения. GitHub
 * разворачивает выражение текстуально ДО того, как шелл увидит скрипт: на месте
 * подстановки оказывается сырое значение секрета, и дальше оно парсится как код.
 * Отсюда три разных отказа, и все три — в `.github/workflows/deploy.yml`:
 *
 *  1. Инъекция. Значение с `'`, `"`, `;`, `$(`, backtick или переводом строки
 *     превращается в команду. Секреты этого репо задаёт владелец, так что это не
 *     «злоумышленник в секрете» — это «опечатка в секрете исполняется на проде».
 *  2. Кавычек нет там, где они обязаны быть: `cd ${{ secrets.DEPLOY_PATH }}`
 *     разваливается на пробеле в пути, а `rsync … :${{ … }}/` тем более.
 *  3. Значение уезжает на чужую машину внутри argv (`ssh host "… $SECRET …"`) —
 *     видно в `ps` и в аудит-логах VPS. Маскировка Actions работает только в
 *     СВОИХ логах и ровно по точному совпадению строки; чужой `journalctl`
 *     она не покрывает.
 *
 * Правильная форма уже есть в этом же файле — шаг «Restore userbot session»
 * (docblock от 2026-08-12): значение объявлено в `env:`, в команду попадает
 * закавыченная ССЫЛКА `"$VAR"`, а сам секрет уходит по stdin. Здесь то же самое
 * требуется от остальных шагов.
 *
 * Прод и сеть не задействованы: тест только читает файлы workflow.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WF_DIR = join(REPO_ROOT, ".github", "workflows");
const DEPLOY_YML = join(WF_DIR, "deploy.yml");
// deploy.yml удалён при публичном релизе 2026-09-01: его шаги ниже проверять
// нечего. Вернётся файл в .github/workflows/ — блоки включатся сами.
// Общий скан всех воркфлоу этим не затронут — он идёт по readdirSync.
const HAS_DEPLOY = existsSync(DEPLOY_YML);
const DEPLOY = HAS_DEPLOY ? readFileSync(DEPLOY_YML, "utf8") : "";

interface Step {
  name: string;
  /** сырые строки шага, от `- name:` до начала следующего шага */
  lines: string[];
}

/** Шаги job'а объявлены с ровно шестью пробелами отступа — по ним и режем. */
function steps(yml: string): Step[] {
  const lines = yml.split("\n");
  const heads: number[] = [];
  lines.forEach((l, i) => {
    if (/^ {6}- name: /.test(l)) heads.push(i);
  });
  return heads.map((s, k) => ({
    name: lines[s].replace(/^ {6}- name: /, "").trim(),
    lines: lines.slice(s, k + 1 < heads.length ? heads[k + 1] : lines.length),
  }));
}

/**
 * Тело `run:` — и блочное (`run: |`), и однострочное.
 * Возвращается вместе с номерами строк: в отчёте об ошибке нужен адрес.
 */
function runLines(lines: string[]): Array<{ off: number; text: string }> {
  const out: Array<{ off: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const block = /^(\s*)run: \|/.exec(lines[i]);
    if (block) {
      const ind = block[1].length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") continue;
        if (l.length - l.trimStart().length <= ind) {
          i = j - 1;
          break;
        }
        out.push({ off: j, text: l });
      }
      continue;
    }
    const inline = /^\s*run: (?!\|)(.+)$/.exec(lines[i]);
    if (inline) out.push({ off: i, text: inline[1] });
  }
  return out;
}

/** Ключи `env:` конкретного шага (env объявлен на шаг, не на job). */
function envKeys(lines: string[]): string[] {
  const i = lines.findIndex((l) => /^ {8}env:\s*$/.test(l));
  if (i < 0) return [];
  const keys: string[] = [];
  for (let j = i + 1; j < lines.length; j++) {
    // комментарии внутри env: — часть блока, а не его конец
    if (/^ {10}#/.test(lines[j]) || lines[j].trim() === "") continue;
    const m = /^ {10}([A-Za-z_][A-Za-z0-9_]*):/.exec(lines[j]);
    if (!m) break;
    keys.push(m[1]);
  }
  return keys;
}

const stepByName = (name: string): Step => {
  const s = steps(DEPLOY).find((x) => x.name === name);
  if (!s) throw new Error(`шаг «${name}» исчез из deploy.yml`);
  return s;
};
const runText = (name: string) =>
  runLines(stepByName(name).lines)
    .map((l) => l.text)
    .join("\n");

describe("во всех workflow: секреты не подставляются в текст shell-команды", () => {
  test("ни одно ${{ … }} не разворачивается внутри run:", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(WF_DIR).filter((f) => f.endsWith(".yml"))) {
      const src = readFileSync(join(WF_DIR, f), "utf8");
      const lines = src.split("\n");
      for (const { off, text } of runLines(lines)) {
        if (text.includes("${{")) {
          offenders.push(`${f}:${off + 1}: ${text.trim().slice(0, 100)}`);
        }
      }
    }
    // Значения приходят через env:, в run: остаётся только "$VAR".
    expect(offenders).toEqual([]);
  });

  test("секреты вообще не встречаются вне env:/with:", () => {
    const offenders: string[] = [];
    for (const f of readdirSync(WF_DIR).filter((f) => f.endsWith(".yml"))) {
      const lines = readFileSync(join(WF_DIR, f), "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!l.includes("secrets.")) return;
        // объявление (`KEY: ${{ secrets.X }}`) и комментарии — законны
        if (/^\s*#/.test(l)) return;
        if (/^\s*[A-Za-z_][A-Za-z0-9_-]*:\s*/.test(l)) return;
        offenders.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});

describe.skipIf(!HAS_DEPLOY)("deploy.yml: rsync на VPS", () => {
  const NAME = "Rsync to VPS";

  test("адрес назначения собран из env, а не из подстановки", () => {
    const keys = envKeys(stepByName(NAME).lines);
    expect(keys).toContain("DEPLOY_USER");
    expect(keys).toContain("DEPLOY_HOST");
    expect(keys).toContain("DEPLOY_PATH");
  });

  test("назначение закавычено целиком — пробел в пути не рвёт команду", () => {
    const body = runText(NAME);
    expect(body).toContain('"$DEPLOY_USER@$DEPLOY_HOST:$DEPLOY_PATH/"');
  });

  test("проверка полноты чекаута перед rsync --delete осталась на месте", () => {
    const body = runText(NAME);
    // Гарантия от 2026-08-12: пустой ./agent/ + --delete = стёртый прод.
    expect(body).toContain("orchestrator-team.ts package.json");
    expect(body).toContain("rsync --delete отменён");
  });
});

describe.skipIf(!HAS_DEPLOY)("deploy.yml: удалённые install/restart и health check", () => {
  const INSTALL = "Remote install + restart";
  const HEALTH = "Post-deploy health check";

  test("оба шага объявляют то, чем пользуются, в своём env:", () => {
    expect(envKeys(stepByName(INSTALL).lines)).toEqual(
      expect.arrayContaining([
        "DEPLOY_USER",
        "DEPLOY_HOST",
        "DEPLOY_PATH",
        "DEPLOY_SERVICE",
      ]),
    );
    expect(envKeys(stepByName(HEALTH).lines)).toEqual(
      expect.arrayContaining(["DEPLOY_USER", "DEPLOY_HOST", "DEPLOY_SERVICE"]),
    );
  });

  test("ssh-цель закавычена в обоих шагах", () => {
    for (const n of [INSTALL, HEALTH]) {
      expect(runText(n)).toContain('"$DEPLOY_USER@$DEPLOY_HOST"');
    }
  });

  test("remote-скрипт уходит по stdin, а не внутри argv", () => {
    // Тот же приём, что и в «Restore userbot session»: значения передаются
    // позиционными аргументами, сам скрипт — на stdin, в argv секретов нет.
    const body = runText(INSTALL);
    expect(body).toMatch(/\|\s*ssh /);
    expect(body).toContain("sh -s --");
  });

  test("удалённый путь и имя юнита закавычены на той стороне", () => {
    const body = runText(INSTALL);
    expect(body).toMatch(/cd "\$\d"|cd '\$\d'|cd "\$[A-Z_]+"/);
    expect(body).not.toMatch(/systemctl restart \$[A-Za-z0-9_]+\s/);
  });

  test("шаги по-прежнему пропускаются в dry-run", () => {
    for (const n of [INSTALL, HEALTH]) {
      expect(stepByName(n).lines.join("\n")).toContain(
        "if: github.event.inputs.dry_run != 'true'",
      );
    }
  });

  test("health check всё так же требует ok:true и печатает журнал при провале", () => {
    const body = runText(HEALTH);
    expect(body).toContain("localhost:8787/api/health");
    expect(body).toContain("journalctl");
  });
});

describe.skipIf(!HAS_DEPLOY)("deploy.yml: образец, по которому чинились остальные", () => {
  test("«Restore userbot session» не растерял передачу секрета по stdin", () => {
    const body = runText("Restore userbot session if missing");
    expect(body).toContain('printf \'%s\' "$USERBOT_SESSION_B64" | ssh');
    expect(body).not.toContain("${{");
  });
});
