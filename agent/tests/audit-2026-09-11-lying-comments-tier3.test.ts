/**
 * Аудит 2026-09-11, круг 51, третий ярус: комментарии, врущие о том, чего
 * читатель проверить не может, не открыв соседний файл.
 *
 * Первый ярус менял решение читателя, второй считал прозой. Здесь — призраки
 * адресов и обещаний: «см. STATUS.md» при отсутствующем файле, «respondAs() из
 * orchestrator-team.ts» при функции в lib/handoff.ts, «подключим eliza» при
 * отсутствующей зависимости, «File I/O in hot paths» у скрипта, который меряет
 * только SQLite, «preAuth для логирования» у флага, держащего анонимный
 * рейт-лимит, «обезвреживается без исключений» при двух намеренных исключениях.
 *
 * Общее у них одно: проверка стоит дороже чтения. Именно поэтому такие фразы
 * живут годами — и именно поэтому их надо держать тестом, а не вниманием.
 *
 * Правило круга 22 применяется дословно: имя в обратных кавычках — обещание,
 * что символ существует по этому адресу. Не существует — кавычки снимаются
 * вместе с адресом, а прошедшее время остаётся надгробием.
 */
import { test, expect, describe } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { MEDIA_MARKER_INNER } from "../lib/media-markers.ts";
import { defuseSpeakerLabels } from "../lib/agent-prompts.ts";

function src(rel: string): string {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}
function flat(s: string): string {
  return s.replace(/^\s*\*/gm, "").replace(/\s+/g, " ");
}
/** Путь от корня воркри (не от agent/) — для файлов вроде STATUS.md. */
function repoPath(rel: string): string {
  return new URL(`../../${rel}`, import.meta.url).pathname;
}

describe("призраки адресов сняты", () => {
  test("formatReviewSummary не ссылается на несуществующий STATUS.md", () => {
    // Сначала замер: файла в дереве действительно нет.
    expect(existsSync(repoPath("STATUS.md"))).toBe(false);
    expect(existsSync(new URL("../STATUS.md", import.meta.url).pathname)).toBe(false);
    const review = src("orchestrator/review-mode.ts");
    const at = review.indexOf("export function formatReviewSummary");
    const doc = flat(review.slice(review.lastIndexOf("/**", at), at));
    expect(doc.indexOf("круг 51")).toBeLessThan(
      doc.indexOf('for the STATUS.md "Control loop" section'),
    );
    expect(doc).toContain("печатает результат в stdout");
    // Единственный вызывающий и правда печатает, а не пишет файл.
    const agent = src("agent.ts");
    const call = agent.slice(agent.indexOf("formatReviewSummary(result"));
    expect(call.slice(0, 200)).toContain("console.log(summary)");
  });

  test("test-handoff указывает на настоящий дом respondAs", () => {
    expect(src("lib/handoff.ts")).toContain("export async function respondAs(");
    expect(src("orchestrator-team.ts")).not.toContain("respondAs");
    const doc = flat(src("tools/test-handoff.ts").slice(0, 1400));
    expect(doc).toContain("`respondAs()` из lib/handoff.ts");
    // Старый адрес остался только разобранным.
    expect(doc.indexOf("круг 51")).toBeLessThan(doc.indexOf("из orchestrator-team.ts»"));
  });

  test("обещание подключить eliza снято в обоих раннерах", () => {
    // Замер: зависимости нет ни в одном манифесте дерева.
    const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    expect(pkg.toLowerCase()).not.toContain("eliza");
    for (const file of ["orchestrator-bot.ts", "orchestrator-userbot.ts"]) {
      const doc = flat(src(file).slice(0, 1800));
      // Обещание уцелело только внутри разбора — значит, оно процитировано,
      // а не действует.
      expect(doc.indexOf("круг 51")).toBeGreaterThan(-1);
      expect(doc.indexOf("круг 51")).toBeLessThan(doc.indexOf("подключим"));
      expect(doc).toContain("зависимости");
    }
  });

  test("restore-from-backup не обещает фиксированный /tmp/restore-test/", () => {
    const restore = src("tools/restore-from-backup.ts");
    expect(restore).not.toContain("test location (/tmp/restore-test/)");
    // Настоящий каталог — свежий, с меткой времени, внутри os.tmpdir().
    expect(restore).toContain("join(tmpdir(), `restore-test-${Date.now()}`)");
  });
});

describe("обещания покрытия сверены с кодом", () => {
  test("perf-benchmark не обещает мерить файловый I/O", () => {
    const bench = src("tools/perf-benchmark.ts");
    const header = bench.slice(0, bench.indexOf("*/") + 2);
    expect(header).not.toContain("- File I/O in hot paths");
    // Замер: ни одного файлового вызова в теле скрипта.
    const body = bench.slice(header.length);
    expect(body).not.toMatch(/readFileSync|writeFileSync|readdirSync|statSync/);
    // Зато шесть замеров БД на месте.
    expect(body.match(/benchmark\("/g)?.length).toBe(6);
  });

  test("шапка miniapp-server называет настоящее назначение preAuth", () => {
    const mini = src("lib/miniapp-server.ts");
    const header = flat(mini.slice(0, mini.indexOf("*/") + 2));
    expect(header).toContain("`preAuth` для анонимного рейт-лимита");
    expect(header).toContain("Аудит 2026-09-11");
    // Замер: флаг читают только вёдра, не логирование.
    const uses = mini
      .split("\n")
      .filter((l) => /\bpreAuth\b/.test(l) && !l.trimStart().startsWith("*"));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).not.toContain("log.info");
      expect(line).not.toContain("log.warn");
    }
  });

  test("MEDIA_MARKERS честно называет свои два исключения", () => {
    const doc = flat(src("lib/agent-prompts.ts"));
    expect(doc).toContain("Исключений ровно два, и оба намеренные");
    // Оба исключения существуют на самом деле — иначе честность была бы новой ложью.
    expect(defuseSpeakerLabels("[orchestrator] привет")).toBe("(orchestrator) привет");
    expect(defuseSpeakerLabels("[файл: orchestrator] привет")).toBe("[файл: orchestrator] привет");
    expect(defuseSpeakerLabels("привет [orchestrator] тут")).toBe("привет [orchestrator] тут");
    expect(MEDIA_MARKER_INNER.test("файл: orchestrator")).toBe(true);
  });
});

describe("счётчики в прозе убраны, а не подогнаны", () => {
  test("agent-sdk-runtime не называет число enum-мест", () => {
    const runtime = src("lib/agent-sdk-runtime.ts");
    const at = runtime.indexOf("function propToZod");
    const doc = flat(runtime.slice(runtime.lastIndexOf("/**", at), at));
    expect(doc).toContain("ни в одном месте, где схема их перечисляет");
    expect(doc.indexOf("круг 51")).toBeLessThan(doc.indexOf("ни у одного из пятнадцати мест"));
    // Замер: сколько мест на самом деле.
    const enums = src("lib/tools-schema.ts").match(/\benum\s*:/g)?.length ?? 0;
    expect(enums).toBeGreaterThan(0);
    expect(enums).not.toBe(15);
  });

  test("rate-limits считает чужие ключи, а не все подряд", () => {
    const rl = src("lib/rate-limits.ts");
    expect(rl).not.toContain("из пяти форматов ключа четыре");
    expect(rl).toContain("а четыре формата ключа содержат chatId");
    // Замер: форматов действительно семь, чужих среди них четыре.
    const formats = [
      "`agent:${agentKey}:${actionType}`",
      "`global:${actionType}`",
      "`agent-all:${agentKey}`",
      "`chat:${chatId}:${actionType}`",
      "`bot:${botId}:chat:${chatId}:${actionType}`",
      "`userbot:${userbotAccountKey(characterId)}:chat:${chatId}`",
      "`ingest:chat:${chatId}:user:${userId}`",
    ];
    for (const f of formats) expect(rl).toContain(f);
    const foreign = formats.filter((f) => f.includes("chatId") || f.includes("userId"));
    expect(foreign.length).toBe(4);
    expect(formats.length).toBe(7);
  });
});
