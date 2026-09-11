/**
 * Аудит 2026-08-10: автомерж не считал рискованной инфраструктуру.
 *
 * `validatePrChecklist` помечает PR как risky (→ комментарий и человек) только
 * по каталогам с кодом агентов. Всё прочее при зелёных чеках уходило в
 * `gh pr merge --squash` прямо в main — включая `.github/workflows/`, то есть
 * описание того, что запускается в CI и к каким секретам имеет доступ
 * (deploy.yml ходит на прод-VPS по ключу из secrets), `deploy/deploy.sh` и
 * systemd-юниты, исполняемые на сервере под root, и `package.json` с составом
 * зависимостей — при том что CLAUDE.md hard rule 7 прямо запрещает поднимать
 * версии без задачи.
 *
 * Классификатор при этом писал в PR «✅ Validation Passed»: не «мы не увидели
 * риска», а «риска нет».
 *
 * Инвариант: автоматически вливается только то, что не меняет ни поведение
 * ботов, ни правила их запуска, ни то, где и с какими правами это исполняется.
 */
import { describe, test, expect } from "bun:test";
import { isRiskyPath, handleReviewAndMergePr, type GhRunner } from "../lib/dispatch/github.ts";

describe("инфраструктура рискованна", () => {
  for (const f of [
    ".github/workflows/deploy.yml",
    ".github/workflows/agents-team.yml",
    ".github/actions/setup/action.yml",
    "deploy/deploy.sh",
    "deploy/systemd/agent-team.service",
    "package.json",
    "agent/package.json",
    "bun.lock",
    "bunfig.toml",
  ]) {
    test(f, () => expect(isRiskyPath(f)).toBe(true));
  }
});

describe("инструкции агентам рискованны", () => {
  for (const f of ["CLAUDE.md", "AGENT.md", ".claude/agents/backend.md"]) {
    test(f, () => expect(isRiskyPath(f)).toBe(true));
  }

  test("память автономного цикла требует человека", () => {
    expect(isRiskyPath(".claude/memory/notes/foo.md")).toBe(true);
    expect(isRiskyPath(".claude/memory/MEMORY.md")).toBe(true);
  });
});

describe("прежняя классификация не сломана", () => {
  test("код агентов по-прежнему risky", () => {
    expect(isRiskyPath("agent/lib/permissions.ts")).toBe(true);
    expect(isRiskyPath("agent/characters/pm.ts")).toBe(true);
    expect(isRiskyPath("agent/orchestrator/message-handler.ts")).toBe(true);
    expect(isRiskyPath("agent/tools/probe.ts")).toBe(true);
  });

  test("markdown рядом с кодом агентов — не risky", () => {
    expect(isRiskyPath("agent/ONBOARDING.md")).toBe(false);
    // Изъятия из этого правила — см. tests/pr-risky-paths-allowlist.test.ts:
    // расширение файла не делает его документацией.
    expect(isRiskyPath("agent/memory/_team/log.md")).toBe(true);
  });

  test("доски и статусы требуют человека", () => {
    expect(isRiskyPath("TASKS.md")).toBe(true);
    expect(isRiskyPath("STATUS.md")).toBe(true);
  });

  test("тесты и Mini App — теперь к человеку (аудит 2026-08-11)", () => {
    // Здесь стояло «автомержатся как и раньше»: остаток чёрного списка, а не
    // решение. Белый список второго пути обе группы не брал ни дня, то есть
    // два пути автомержа отвечали по-разному на один и тот же файл. Мини-апп
    // — код, который отдаётся пользователям по HTTPS; правка теста — то, чем
    // следующий PR проходит проверку.
    //
    // Второго пути с 2026-09-01 нет: воркфлоу удалён при публичном релизе,
    // уцелевший `case` лежит в .github/scripts/automerge-filter.sh и никем не
    // вызывается (tests/audit-2026-09-11-automerge-single-path.test.ts).
    expect(isRiskyPath("agent/tests/foo.test.ts")).toBe(true);
    expect(isRiskyPath("agent/miniapp/src/pages/Settings.tsx")).toBe(true);
  });
});

/** Фейковый `gh`: зелёные чеки, один изменённый файл. */
function fakeGh(path: string): { runGh: GhRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runGh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return {
        stdout: JSON.stringify({
          files: [{ path }],
          state: "OPEN",
          mergeable: "MERGEABLE",
          changedFiles: 1,
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
  return { runGh, calls };
}

describe("сквозь весь обработчик", () => {
  test("PR с правкой воркфлоу не мержится, а уходит человеку", async () => {
    const gh = fakeGh(".github/workflows/deploy.yml");
    const res = await handleReviewAndMergePr({ pr_number: 7 }, { agentKey: "orchestrator", chatId: 0 }, { runGh: gh.runGh, authority: "approved-action" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.action).toBe("commented");
    expect(gh.calls.some((c) => c[1] === "merge")).toBe(false);
  });

  test("PR с одним тестом тоже уходит человеку", async () => {
    const gh = fakeGh("agent/tests/foo.test.ts");
    const res = await handleReviewAndMergePr({ pr_number: 8 }, { agentKey: "orchestrator", chatId: 0 }, { runGh: gh.runGh, authority: "approved-action" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.action).toBe("commented");
    expect(gh.calls.some((c) => c[1] === "merge")).toBe(false);
  });

  test("PR с заметкой памяти уходит человеку", async () => {
    const gh = fakeGh(".claude/memory/notes/x.md");
    const res = await handleReviewAndMergePr({ pr_number: 9 }, { agentKey: "orchestrator", chatId: 0 }, { runGh: gh.runGh, authority: "approved-action" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result.action).toBe("commented");
    expect(gh.calls.some((c) => c[1] === "merge")).toBe(false);
  });
});
