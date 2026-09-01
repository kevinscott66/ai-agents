/**
 * Аудит 2026-08-11: третий заход на один и тот же классификатор.
 *
 * `isRiskyPath` — чёрный список: что не названо рискованным, то уходит в
 * `gh pr merge --squash` в main без человека. Такой список чинится ровно тем
 * способом, каким чинился дважды до этого: аудит находит очередной непойманный
 * путь и дописывает строку. 2026-08-08 — усечение списка файлов, 2026-08-10 —
 * `.github/`, `deploy/`, `package.json`, CLAUDE.md/AGENT.md. Каждый раз это был
 * не новый файл в репо, а старый, которого не было в перечислении.
 *
 * Что оставалось непойманным на сегодня — и это не гипотетические пути,
 * а реальные файлы в `git ls-files`:
 *
 *  • `agent/mac-daemon/**` — демон, исполняющий Claude на машине владельца.
 *    MAC_RUN_CLAUDE описан в permissions.ts как «RCE на машине владельца»,
 *    заперт на orchestrator НА УРОВНЕ КОДА (таблица прав не должна быть
 *    единственным гейтом) и всегда требует апрува. Правка самого демона при
 *    этом вливалась автоматически.
 *  • `agent/login-userbot.ts`, `agent/join-group.ts`, `agent/list-dialogs.ts`,
 *    `agent/agent.ts`, `agent/send-test.ts` — код, действующий реальным
 *    аккаунтом владельца в Telegram. Тот же `agent/tools/`, только на этаж выше.
 *  • `agent/tsconfig.json`, `agent/miniapp/vite.config.ts` — как собирается то,
 *    что уезжает на прод.
 *  • `.claude/settings.json` — хуки Claude Code. Файла в репо нет; PR, который
 *    его ДОБАВИТ, классификатор назовёт безопасным, а следующий автономный
 *    прогон исполнит хуки на runner'е с секретами.
 *
 * Второй путь автомержа — `.github/workflows/auto-merge.yml` — устроен
 * наоборот: `case` перечисляет безопасное, всё остальное отсекает `*)`. Шапка
 * того файла прямо утверждает «То же правило продублировано в isRiskyPath()».
 * Тест 2026-08-10 проверял это утверждение в одну сторону — «что белый список
 * считает безопасным, чёрный не считает рискованным». Опасна ровно другая:
 * что ЧЁРНЫЙ пускает мимо человека, а белый бы не пустил.
 *
 * Инвариант: `isRiskyPath` — тоже белый список, и его безопасный набор
 * совпадает с воркфлоу с точностью до одного явно названного исключения.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRiskyPath } from "../lib/dispatch/github.ts";

/**
 * Единственное расхождение с воркфлоу, оставленное намеренно: markdown рядом с
 * кодом агентов (`agent/lib/README.md`) — это документация, а не поведение.
 * Список именно здесь, чтобы следующее расхождение пришлось внести в тест
 * руками, а не обнаружить аудитом.
 *
 * Аудит 2026-08-12: `agent/characters/` изъят из исключения — см. describe ниже.
 */
const KNOWN_EXCEPTIONS = [
  (f: string) =>
    f.startsWith("agent/") && f.endsWith(".md") && !f.startsWith("agent/characters/"),
];

describe("реальные файлы репо, которые чёрный список не видел", () => {
  for (const f of [
    "agent/mac-daemon/daemon.ts",
    "agent/mac-daemon/package.json",
    "agent/agent.ts",
    "agent/login-userbot.ts",
    "agent/join-group.ts",
    "agent/list-dialogs.ts",
    "agent/send-test.ts",
    "agent/orchestrator-team.ts",
    "agent/tsconfig.json",
    "agent/miniapp/vite.config.ts",
    "agent/miniapp/index.html",
  ]) {
    test(f, () => expect(isRiskyPath(f)).toBe(true));
  }

  test(".claude/settings.json — хуки, которых в репо ещё нет", () => {
    // Классификатор обязан отвечать про файл, которого не существует: PR,
    // который его добавит, — как раз тот случай, ради которого он написан.
    expect(isRiskyPath(".claude/settings.json")).toBe(true);
    expect(isRiskyPath(".claude/settings.local.json")).toBe(true);
  });

  test("незнакомый путь по умолчанию рискован, а не безопасен", () => {
    expect(isRiskyPath("infra/terraform/main.tf")).toBe(true);
    expect(isRiskyPath("Makefile")).toBe(true);
    expect(isRiskyPath("scripts/wipe-prod.sh")).toBe(true);
  });
});

describe("безопасный набор не сузился", () => {
  for (const f of [
    "docs/adr/0001.md",
    "README.md",
    ".github/workflows/README-deploy-secrets.md",
    "agent/lib/README.md",
  ]) {
    test(f, () => expect(isRiskyPath(f)).toBe(false));
  }

  test("model-consumed memory, task, and status files require a human", () => {
    for (const f of [
      ".claude/memory/notes/foo.md",
      ".claude/memory/MEMORY.md",
      "TASKS.md",
      "STATUS.md",
      "STATUS-frontend.md",
      "WATCHDOG.md",
    ]) {
      expect(isRiskyPath(f)).toBe(true);
    }
  });
});

/**
 * Аудит 2026-08-12: четвёртый заход, и снова не гипотеза, а `git ls-files`.
 *
 * Исключение «markdown рядом с кодом агентов» записано одним предикатом —
 * `agent/**\/*.md`. Писалось оно под `agent/lib/README.md` и объясняется в шапке
 * github.ts как «документация, а не поведение». Но предикат шире объяснения, и
 * под него уже попадают реальные файлы репо:
 *
 *   agent/characters/prompts/copy/{announcement,digest,faq,story}.md
 *
 * Про эту директорию оба других источника правды высказываются прямо и
 * противоположно: анти-список auto-merge.yml — «agent/characters/** (system
 * prompts — никогда auto)», CLAUDE.md §3.8 п.3 — «это risky: по определению,
 * только PR». То есть воркфлоу такой PR отсекает, а оркестраторский путь тот же
 * PR сквошит в main сам. Расширение файла не делает его документацией: в
 * каталоге с именем `prompts/` лежит то, чем пишет роль copy.
 *
 * Инвариант: `agent/characters/**` рискован целиком, независимо от расширения.
 */
describe("agent/characters/** — никогда автоматически", () => {
  for (const f of [
    "agent/characters/index.ts",
    "agent/characters/prompts/copy/announcement.md",
    "agent/characters/prompts/copy/digest.md",
    "agent/characters/prompts/copy/faq.md",
    "agent/characters/prompts/copy/story.md",
    // Файлов ещё нет, но классификатор обязан отвечать и про них.
    "agent/characters/orchestrator.json",
    "agent/characters/README.md",
  ]) {
    test(f, () => expect(isRiskyPath(f)).toBe(true));
  }

  test("исключение осталось ровно тем, ради чего писалось", () => {
    expect(isRiskyPath("agent/lib/README.md")).toBe(false);
    expect(isRiskyPath("agent/docs/DEPLOY.md")).toBe(false);
    expect(isRiskyPath("agent/mac-daemon/README.md")).toBe(false);
  });
});

describe("оба пути автомержа согласованы в обе стороны", () => {
  // Аудит 2026-08-12: белый список переехал из инлайна auto-merge.yml в
  // .github/scripts/automerge-filter.sh (is_safe_path), чтобы решение об
  // автомёрдже можно было прогонять тестами. Инвариант тот же: два пути
  // автомержа — воркфлоу и оркестраторский isRiskyPath() — обязаны сходиться.
  const WF = readFileSync(
    join(import.meta.dir, "..", "..", ".github", "scripts", "automerge-filter.sh"),
    "utf8",
  );

  /** Шаблоны из safe-ветки `case` скрипта — всё до закрывающего `*)`. */
  function safePatterns(): string[] {
    const from = WF.indexOf('case "$1" in');
    expect(from).toBeGreaterThan(-1);
    const rest = WF.slice(from);
    const end = rest.search(/^\s*\*\)\s*return 1 ;;$/m);
    expect(end).toBeGreaterThan(0);
    return rest
      .slice(0, end)
      .split("\n")
      .map((l) => l.trim().match(/^(.*)\)\s*return 0 ;;$/)?.[1])
      .filter((p): p is string => p !== undefined)
      .flatMap((p) => p.split("|"));
  }

  /** Грубый матчер shell-глоба из `case` — достаточно `*` в конце/середине. */
  function globMatches(pattern: string, f: string): boolean {
    const rx = new RegExp(
      "^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    );
    return rx.test(f);
  }

  const CANDIDATES = [
    "agent/mac-daemon/daemon.ts",
    "agent/tests/foo.test.ts",
    "agent/miniapp/src/pages/Settings.tsx",
    "agent/agent.ts",
    "agent/tsconfig.json",
    ".claude/settings.json",
    "infra/terraform/main.tf",
    "agent/lib/README.md",
    "agent/characters/prompts/copy/story.md",
    "TASKS.md",
    "docs/x.md",
    ".gitignore",
  ];

  test("что чёрный список пускает мимо человека — пустил бы и белый", () => {
    const patterns = safePatterns();
    for (const f of CANDIDATES) {
      if (isRiskyPath(f)) continue;
      const inWorkflow = patterns.some((p) => globMatches(p, f));
      const known = KNOWN_EXCEPTIONS.some((ex) => ex(f));
      expect(inWorkflow || known).toBe(true);
    }
  });
});
