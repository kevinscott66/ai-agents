/**
 * Аудит 2026-08-29: оба гейта на секреты открывались от слова в строке.
 *
 * Фильтр заглушек применялся как `grep -avEi -- "$PLACEHOLDER"` — без
 * якорей, регистронезависимо и КО ВСЕЙ СТРОКЕ. Строка выпадала из находок,
 * если где угодно в ней встречалась любая подстрока из списка. В CI-версии
 * список шире и включает `dev`, `ci`, `test`, `local`, а в обеих версиях
 * есть `<` и `>`.
 *
 * Отсюда два рабочих обхода, оба — штатный вид строки, а не экзотика:
 *   TELEGRAM_BOT_TOKEN_DEV=<токен>            → гасит подстрока `DEV`
 *   curl -H "Authorization: Bearer <ключ>" > f → гасит символ `>`
 *
 * Для CI это означает секрет в main мимо зелёного гейта; для VPS-скрипта —
 * секрет в коммите автономного цикла, за которым идут push и PR.
 *
 * Лечится сужением области: заглушку ищем в САМОМ совпавшем значении
 * (`grep -oE` перед фильтром), а не в строке вокруг него. Заглушки при этом
 * продолжают работать — `TOKEN=<your-token-here>` и синтетические фикстуры
 * тестов содержат слово-заглушку внутри значения.
 *
 * Значения ниже синтетические: shape-based паттерны не отличают A-повтор от
 * реального ключа, а печатать реальные нельзя ни при каких условиях.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..", "..");
/*
 * Аудит 2026-08-29: тесты этого файла поднимают временный git-репозиторий и
 * запускают shell-скрипт — в одиночку это ~2.6 с, но под полным прогоном
 * (786 файлов в одном процессе) те же вызовы растягивались до 7–22 с и
 * упирались в дефолтные 5000 мс bun. Падал не код, а таймер: гейт краснел
 * случайно, от нагрузки соседей. Отсюда явный запас, а не надежда на дефолт —
 * тот же приём, что в tests/scan-staged-secrets.test.ts.
 */
const SPAWN_TIMEOUT_MS = 60_000;
const slowTest = (name: string, fn: () => void | Promise<void>) =>
  test(name, fn, SPAWN_TIMEOUT_MS);

const CI_SCRIPT = join(ROOT, ".github", "scripts", "check-secret-hygiene.sh");
const VPS_SCRIPT = join(ROOT, "deploy", "vps-autonomous", "scan-staged-secrets.sh");

const BOT_TOKEN = `8123456789:${"A".repeat(35)}`;
const ANT_KEY = `sk-ant-${"B".repeat(40)}`;

function git(dir: string, ...args: string[]) {
  return spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function newRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  return dir;
}

/** Прогон CI-гейта на диапазоне base..head. */
function ciScan(body: string): number {
  const dir = newRepo("secret-scope-ci-");
  try {
    writeFileSync(join(dir, "note.md"), "safe\n");
    git(dir, "add", "note.md");
    git(dir, "commit", "-qm", "base");
    const base = git(dir, "rev-parse", "HEAD").stdout.trim();
    writeFileSync(join(dir, "note.md"), body);
    git(dir, "add", "note.md");
    git(dir, "commit", "-qm", "head");
    const head = git(dir, "rev-parse", "HEAD").stdout.trim();
    return spawnSync("bash", [CI_SCRIPT, base, head], { cwd: dir, encoding: "utf8" }).status ?? -1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Прогон VPS-гейта на застейдженном содержимом. */
function vpsScan(body: string): number {
  const dir = newRepo("secret-scope-vps-");
  try {
    writeFileSync(join(dir, "note.md"), body);
    git(dir, "add", "note.md");
    return spawnSync("bash", [VPS_SCRIPT], { cwd: dir, encoding: "utf8" }).status ?? -1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("предпосылки", () => {
  slowTest("без слова-обходчика оба гейта эти же значения ловят", () => {
    expect(ciScan(`TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\n`)).toBe(1);
    expect(vpsScan(`TELEGRAM_BOT_TOKEN=${BOT_TOKEN}\n`)).toBe(1);
  });
});

describe("CI-гейт: слово в строке больше не открывает его", () => {
  slowTest("суффикс _DEV в имени переменной не гасит находку", () => {
    expect(ciScan(`TELEGRAM_BOT_TOKEN_DEV=${BOT_TOKEN}\n`)).toBe(1);
  });

  slowTest("остальные широкие слова списка — тоже", () => {
    for (const name of ["TOKEN_TEST", "TOKEN_LOCAL", "CI_TOKEN", "TOKEN_FAKE"]) {
      expect(ciScan(`${name}=${BOT_TOKEN}\n`)).toBe(1);
    }
  });

  slowTest("перенаправление вывода в той же строке не гасит находку", () => {
    expect(ciScan(`curl -H "Authorization: Bearer ${ANT_KEY}" > /tmp/out.json\n`)).toBe(1);
  });

  slowTest("слово-заглушка в имени переменной не делает значение заглушкой", () => {
    // Класс secret-assignment: совпадение начинается с имени переменной, и без
    // снятия префикса `ИМЯ=` подстрока DEV в нём гасила бы находку и после -o.
    expect(ciScan(`DEV_SECRET=${"Q".repeat(24)}\n`)).toBe(1);
    expect(ciScan(`CI_API_KEY = "${"Q".repeat(24)}"\n`)).toBe(1);
  });
});

describe("VPS-гейт: то же сужение", () => {
  slowTest("перенаправление вывода не гасит находку", () => {
    expect(vpsScan(`curl -H "Authorization: Bearer ${ANT_KEY}" > /tmp/out.json\n`)).toBe(1);
  });

  slowTest("угловая скобка где угодно в строке не гасит находку", () => {
    expect(vpsScan(`# см. <docs/deploy.md>\nANTHROPIC_API_KEY=${ANT_KEY}\n`)).toBe(1);
  });
});

describe("заглушки продолжают проходить", () => {
  slowTest("ссылка на переменную окружения не считается значением секрета", () => {
    const body = "SESSION_KEY_RAW = process.env.USERBOT_SESSION_KEY\n";
    expect(ciScan(body)).toBe(0);
    expect(vpsScan(body)).toBe(0);
  });

  slowTest("<your-token-here> и подобное не ломают гейт", () => {
    for (const body of [
      "TOKEN=<your-token-here>\n",
      "ANTHROPIC_API_KEY=sk-ant-example-placeholder-value-0000\n",
      `TELEGRAM_TOKEN=1234567890:${"x".repeat(35)}\n`,
      "SESSION_SECRET = 'changeme-changeme-changeme'\n",
    ]) {
      expect(ciScan(body)).toBe(0);
      expect(vpsScan(body)).toBe(0);
    }
  });

  slowTest("обычные строки без секретов проходят", () => {
    expect(ciScan("просто заметка\n")).toBe(0);
    expect(vpsScan("просто заметка\n")).toBe(0);
  });
});
