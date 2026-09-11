/**
 * Аудит 2026-09-11, круг 50: живой гейт автомержа не спрашивал, КТО прислал PR.
 *
 * Записанная политика личность проверяет, и первой из всех проверок: пункт 3
 * шапки `.github/scripts/automerge-filter.sh` (аудит 2026-08-29) — «форк
 * отсекается, а автор обязан быть в аллоу-листе», и рядом, в самом скрипте:
 * «Личность — раньше всех прочих проверок». Воркфлоу, который звал скрипт,
 * удалён при публичном релизе 2026-09-01; с тех пор единственный автомерж —
 * `handleReviewAndMergePr` в agent/lib/dispatch/github.ts, а он запрашивал у
 * gh `files,state,mergeable,changedFiles,isDraft,labels,headRefOid` и
 * личности не смотрел нигде.
 *
 * Сценарий на публичном репозитории: посторонний форкает, шлёт PR, правящий
 * один `README.md`. Чеклист отвечает зелено на всё — open, не черновик, без
 * меток, без конфликта, один файл, не risky, — и остаётся `gh pr merge
 * --squash` в main. Единственным препятствием была настройка GitHub (первому
 * PR нового контрибьютора нужно одобрение на запуск воркфлоу, второму — уже
 * нет), то есть ровно то, что аудит 2026-08-29 признал недостаточным и
 * заменил аллоу-листом.
 *
 * Человек в цепочке был и остаётся: мерж требует потреблённого одобрения. Но
 * карточка одобрения печатает номер PR и причину, которую пишет модель, — ни
 * автора, ни ветки, ни того, форк это или нет. Проверку, которую политика
 * делает первой, живой путь делегировал человеку и личность ему не показывал.
 *
 * Правка: те же два поля запрашиваются у gh, и незнакомая личность отвечает
 * тем же, чем политика, — SKIP: ни мержа, ни комментария (комментарий от
 * имени проекта на PR постороннего — не сигнал человеку, а выдача бота
 * наружу). Тесты ниже держат поведение, порядок проверок, fail-closed на
 * пропавших полях и согласие с текстом политики.
 *
 * Заодно пришпилены две мелочи того же места: `mergeable: "UNKNOWN"` больше
 * не считается «конфликтов нет», и ветка `docs/` в белом списке сужена до
 * markdown — третий экземпляр «предикат шире собственной подписи».
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  handleReviewAndMergePr,
  untrustedPrReason,
  automergeAllowedAuthors,
  isRiskyPath,
  type GhRunner,
  type GhRunResult,
} from "../lib/dispatch/github.ts";
import { TRUSTED_PR_IDENTITY, FORK_PR_IDENTITY } from "./helpers/pr-view-fixture.ts";

const OWNER = "kevinscott66";
const ctx = { agentKey: "orchestrator", chatId: -1 };
const POLICY = readFileSync(
  join(import.meta.dir, "..", "..", ".github", "scripts", "automerge-filter.sh"),
  "utf8",
);
const SRC = readFileSync(
  join(import.meta.dir, "..", "lib", "dispatch", "github.ts"),
  "utf8",
);

/** Фейковый gh: зелёный PR из одного безопасного файла, личность — аргументом. */
function greenPr(identity: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const runGh: GhRunner = async (args): Promise<GhRunResult> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "view") {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          ...identity,
          state: "OPEN",
          mergeable: "MERGEABLE",
          files: [{ path: "README.md" }],
          changedFiles: 1,
          isDraft: false,
          labels: [],
          headRefOid: "deadbeef",
          ...extra,
        }),
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { runGh, calls };
}

const ran = (calls: string[][], sub: string) =>
  calls.some((c) => `${c[0]} ${c[1]}` === `pr ${sub}`);

async function review(runGh: GhRunner) {
  return handleReviewAndMergePr({ pr_number: 77 }, ctx, { runGh, authority: "approved-action" });
}

describe("чужой PR не вливается и не комментируется", () => {
  test("PR из форка — skip, ни мержа, ни комментария", async () => {
    const { runGh, calls } = greenPr(FORK_PR_IDENTITY);
    const res = await review(runGh);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.action).toBe("skipped");
      expect(res.result.message).toContain("форка");
    }
    // Комментарий на чужом PR — это выдача бота наружу, а не сигнал человеку.
    expect(ran(calls, "merge")).toBe(false);
    expect(ran(calls, "comment")).toBe(false);
  });

  test("свой репозиторий, но автор не в списке — тот же ответ", async () => {
    const { runGh, calls } = greenPr({
      author: { login: "drive-by" },
      isCrossRepository: false,
    });
    const res = await review(runGh);
    if (res.ok) {
      expect(res.result.action).toBe("skipped");
      expect(res.result.message).toContain("drive-by");
    }
    expect(ran(calls, "merge")).toBe(false);
  });

  test("доверенный автор по-прежнему мержится — гейт не съел нормальный путь", async () => {
    const { runGh, calls } = greenPr(TRUSTED_PR_IDENTITY);
    const res = await review(runGh);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.action).toBe("merged");
    expect(ran(calls, "merge")).toBe(true);
  });
});

describe("пропавшее поле — «неизвестно», а не «свой»", () => {
  test("gh не вернул isCrossRepository", async () => {
    const { runGh, calls } = greenPr({ author: { login: OWNER } });
    const res = await review(runGh);
    if (res.ok) expect(res.result.action).toBe("skipped");
    expect(ran(calls, "merge")).toBe(false);
  });

  test("gh не вернул author", async () => {
    const { runGh, calls } = greenPr({ isCrossRepository: false });
    const res = await review(runGh);
    if (res.ok) expect(res.result.action).toBe("skipped");
    expect(ran(calls, "merge")).toBe(false);
  });

  test("пустой логин — не «автор неважен»", () => {
    expect(untrustedPrReason({ author: { login: "  " }, isCrossRepository: false })).toBeString();
    expect(untrustedPrReason({ author: null, isCrossRepository: false })).toBeString();
  });
});

describe("личность — раньше всех прочих проверок", () => {
  test("форк и черновик разом: ответ про форк", async () => {
    // Про чужой PR полезнее узнать, что он чужой, чем что он черновик, —
    // формулировка самой политики.
    const { runGh } = greenPr(FORK_PR_IDENTITY, { isDraft: true });
    const res = await review(runGh);
    if (res.ok) {
      expect(res.result.message).toContain("форка");
      expect(res.result.message).not.toContain("черновик");
    }
  });

  test("у gh спрашивают оба поля — иначе проверять было бы нечего", () => {
    const json = SRC.match(/"--json", "([^"]+)"/)?.[1] ?? "";
    expect(json.split(",")).toContain("author");
    expect(json.split(",")).toContain("isCrossRepository");
  });
});

describe("список доверенных — тот же, что у записанной политики", () => {
  test("по умолчанию — владелец репозитория", () => {
    expect(automergeAllowedAuthors({})).toEqual([OWNER]);
    expect(automergeAllowedAuthors({ AUTOMERGE_ALLOWED_AUTHORS: "   " })).toEqual([OWNER]);
  });

  test("переменная задаёт список", () => {
    const env = { AUTOMERGE_ALLOWED_AUTHORS: `${OWNER}, release-bot` };
    expect(automergeAllowedAuthors(env)).toEqual([OWNER, "release-bot"]);
    expect(untrustedPrReason({ author: { login: "release-bot" }, isCrossRepository: false }, env))
      .toBeUndefined();
    expect(untrustedPrReason({ author: { login: "release-bot" }, isCrossRepository: false }, {}))
      .toBeString();
  });

  test("имя переменной и значение по умолчанию совпадают с политикой", () => {
    // Копия правила в двух файлах: shell-политику нельзя импортировать, но
    // разойтись молча она тоже не должна.
    expect(POLICY).toContain("AUTOMERGE_ALLOWED_AUTHORS");
    expect(POLICY).toContain(`ALLOWED_AUTHORS="${OWNER}"`);
    expect(SRC).toContain(`DEFAULT_AUTOMERGE_AUTHOR = "${OWNER}"`);
  });
});

describe("мерджабельность: «ещё не посчитали» — не «конфликтов нет»", () => {
  test("UNKNOWN не мержится", async () => {
    const { runGh, calls } = greenPr(TRUSTED_PR_IDENTITY, { mergeable: "UNKNOWN" });
    const res = await review(runGh);
    if (res.ok) expect(res.result.action).toBe("skipped");
    expect(ran(calls, "merge")).toBe(false);
  });

  test("поля нет вовсе — тоже не мержится", async () => {
    const { runGh, calls } = greenPr(TRUSTED_PR_IDENTITY, { mergeable: undefined });
    const res = await review(runGh);
    if (res.ok) expect(res.result.action).toBe("skipped");
    expect(ran(calls, "merge")).toBe(false);
  });
});

describe("docs/ — документация по содержимому, а не по имени каталога", () => {
  test("исполняемое из docs/ рискованно", () => {
    expect(isRiskyPath("docs/deploy.sh")).toBe(true);
    expect(isRiskyPath("docs/ci.yml")).toBe(true);
    expect(isRiskyPath("docs/index.html")).toBe(true);
  });

  test("markdown из docs/ по-прежнему безопасен", () => {
    expect(isRiskyPath("docs/adr/0001.md")).toBe(false);
  });

  test("политика сужена тем же образом", () => {
    expect(POLICY).toContain("docs/*.md|README*.md");
  });
});
