/**
 * Аудит 2026-08-12: подстановка недоверенного ввода в shell воркфлоу.
 *
 * `${{ ... }}` в GitHub Actions раскрывается ДО запуска шага: движок склеивает
 * значение в текст скрипта, а уже потом отдаёт его bash. Для `run:` это значит,
 * что кавычки вокруг подстановки ничего не защищают — они часть той же строки,
 * которую подставляемое значение может закрыть.
 *
 * В legacy `.github/workflows/agents-team.yml` так подставлялся `role`:
 *
 *   if [ -n "${{ github.event.inputs.role }}" ] && \
 *      [ "${{ github.event.inputs.role }}" != "${{ matrix.role }}" ]; then
 *
 * Вход объявлен как свободный `type: string` без списка допустимых значений.
 * Значение вида `x" ]; <команда>; [ "` выходит из теста и исполняется на
 * runner'е в джобе role-iterate — до шагов, которым передаются
 * `secrets.CLAUDE_CODE_OAUTH_TOKEN` и `secrets.GITHUB_TOKEN`. Секреты живут в
 * env конкретного шага, но код, исполнившийся раньше в той же джобе, пишет в
 * `$GITHUB_ENV`/`$GITHUB_PATH` и подменяет то, что эти шаги запустят.
 *
 * Legacy workflow отключён: внутренний runtime больше не запускается через
 * workflow dispatch, а SPAWN_ROLE fail-closed. Репозиторий всё равно держит
 * invariant для оставшихся workflow-run блоков — «таблица прав не должна быть
 * единственным гейтом».
 *
 * Инвариант: недоверенный контекст не попадает в текст `run:`. Значение
 * передаётся через `env:` и читается bash'ем как переменная — тогда оно
 * остаётся данными на всех этапах.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WF_DIR = join(import.meta.dir, "..", "..", ".github", "workflows");

/**
 * Контексты, значение которых задаёт не сам воркфлоу: входы dispatch, ветки и
 * тексты, приходящие из событий. Список — из hardening-гайда GitHub; `matrix.*`
 * и `steps.*` сюда не входят намеренно, их пишет этот же файл.
 */
const UNTRUSTED = [
  /github\.event\.inputs\./,
  /(^|[^.\w])inputs\./,
  /github\.head_ref/,
  /github\.event\.(issue|pull_request|comment|review|discussion)\b/,
  /github\.event\.head_commit\./,
];

interface RunBlock {
  file: string;
  line: number;
  text: string;
}

/**
 * Тело каждого `run:` вместе с номером строки. Границу держим по колонке
 * ключа: тело скрипта всегда отбито глубже, чем сам `run:`.
 */
function runBlocks(file: string, yaml: string): RunBlock[] {
  const lines = yaml.split("\n");
  const out: RunBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const col = lines[i]!.search(/(?<![\w-])run:(\s|$)/);
    if (col < 0) continue;
    // Не ключ, а слово внутри строки/комментария.
    if (!/^[\s-]*$/.test(lines[i]!.slice(0, col))) continue;

    const body: string[] = [lines[i]!.slice(col + 4)];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() === "") { body.push(l); continue; }
      if (l.search(/\S/) <= col) break;
      body.push(l);
    }
    out.push({ file, line: i + 1, text: body.join("\n") });
    i = j - 1;
  }
  return out;
}

const FILES = readdirSync(WF_DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));

describe("недоверенный ввод не склеивается в текст run:", () => {
  test("сканер вообще находит run-блоки (иначе тест зелёный впустую)", () => {
    const total = FILES.flatMap((f) => runBlocks(f, readFileSync(join(WF_DIR, f), "utf8")));
    expect(FILES.length).toBeGreaterThan(5);
    expect(total.length).toBeGreaterThan(20);
  });

  for (const f of FILES) {
    test(f, () => {
      const blocks = runBlocks(f, readFileSync(join(WF_DIR, f), "utf8"));
      const bad: string[] = [];
      for (const b of blocks) {
        for (const m of b.text.matchAll(/\$\{\{([^}]*)\}\}/g)) {
          const expr = m[1]!;
          if (UNTRUSTED.some((rx) => rx.test(expr))) {
            bad.push(`${b.file}:${b.line}: \${{${expr}}}`);
          }
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

describe("сканер видит то, что должен видеть", () => {
  test("подстановка в run: ловится, в env: — нет", () => {
    const yaml = [
      "jobs:",
      "  a:",
      "    steps:",
      "      - name: bad",
      "        run: |",
      '          echo "${{ github.event.inputs.role }}"',
      "      - name: good",
      "        env:",
      "          ROLE: ${{ github.event.inputs.role }}",
      "        run: |",
      '          echo "$ROLE"',
      "",
    ].join("\n");
    const blocks = runBlocks("x.yml", yaml);
    expect(blocks.length).toBe(2);
    expect(blocks[0]!.text).toContain("github.event.inputs.role");
    expect(blocks[1]!.text).not.toContain("github.event.inputs.role");
  });

  test("matrix и steps недоверенными не считаются", () => {
    expect(UNTRUSTED.some((rx) => rx.test(" matrix.role "))).toBe(false);
    expect(UNTRUSTED.some((rx) => rx.test(" steps.branch.outputs.branch "))).toBe(false);
    expect(UNTRUSTED.some((rx) => rx.test(" github.event.inputs.role "))).toBe(true);
    expect(UNTRUSTED.some((rx) => rx.test(" inputs.task_hint "))).toBe(true);
  });
});
