/**
 * Аудит 2026-09-11: заголовок miniapp-server.ts обещал, что сервер ничего не
 * исполняет, — через два исполняемых действия в том же файле.
 *
 * Стояло дословно: «Сервер ничего не исполняет сам — только читает/мутирует
 * data-layer» и «После approve approval-action НЕ запускается здесь». Второе
 * предложение перестало быть правдой в T-547, который прямо для этого и делался
 * (одобрение из Mini App было no-op: строка висела в pending_approval, пока то
 * же решение не повторят из Telegram). Первое не было правдой и до него, если
 * считать POST /api/mac/stop: там `dispatchAndAudit` зовётся напрямую, без
 * `evaluateGate`.
 *
 * Цена ровно та же, что у пересчёта исключений из-под HMAC-стены в том же
 * заголовке: аудит, начинающийся с чтения шапки файла, узнаёт, что исполнения
 * тут нет, — и не смотрит, чем защищены две точки, где оно есть.
 *
 * Что здесь пинится и почему так:
 *
 *  - обе точки названы в шапке поимённо — иначе «исполняет два действия»
 *    протухнет счётом, как протухли «все», «ровно одно» и «два» у стены;
 *  - число вызовов `dispatchAndAudit` во всём lib/ зафиксировано вместе со
 *    списком файлов. Пятый вызов — это либо новая точка исполнения, либо
 *    переезд старой; и то и другое обязано пройти через перечитывание шапки;
 *  - сам факт исполнения проверяется по коду маршрутов, а не по шапке:
 *    сторож, сверяющий комментарий с комментарием, доказывает лишь их
 *    согласованность.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../lib", import.meta.url).pathname;
const SRC = readFileSync(join(root, "miniapp-server.ts"), "utf8");
/** Шапка файла — всё до первого импорта. */
const HEADER = SRC.slice(0, SRC.indexOf("import "));

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Строки кода: комментарии вырезаны, остаётся исполняемое. */
const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");

describe("шапка не отрицает того, что файл делает", () => {
  test("прежних отрицаний в ней нет", () => {
    expect(HEADER).not.toContain("Сервер ничего не исполняет сам");
    expect(HEADER).not.toContain("approval-action НЕ запускается здесь");
  });

  test("обе точки исполнения названы поимённо", () => {
    expect(HEADER).toContain("/api/approvals/:id/decide");
    expect(HEADER).toContain("executeApproved");
    expect(HEADER).toContain("/api/mac/stop");
    expect(HEADER).toContain("dispatchAndAudit");
  });
});

describe("точки исполнения — по коду, а не по шапке", () => {
  test("одобренный апрув действительно исполняется здесь", () => {
    const code = codeOnly(SRC);
    expect(code).toContain("await executeApproved(a, approvalDeps)");
    // Отказ не исполняет: ветка одна и она под проверкой статуса.
    expect(code).toContain('if (a.status === "approved")');
  });

  test("стоп-кран диспатчит напрямую и под админской проверкой", () => {
    const route = SRC.slice(
      SRC.indexOf('if (path === "/api/mac/stop" && method === "POST")'),
      SRC.indexOf('// GET /api/dashboard'),
    );
    expect(route).toContain("requireAdmin(user)");
    expect(route).toContain('dispatchAndAudit("MAC_STOP"');
    // Гейта на этом пути нет — это и есть то, о чём шапка обязана сказать.
    expect(route).not.toContain("evaluateGate");
  });
});

describe("счёт точек исполнения зафиксирован", () => {
  test("во всём lib/ ровно четыре вызова dispatchAndAudit и все известны", () => {
    const sites: string[] = [];
    for (const f of walk(root)) {
      const rel = f.slice(root.length + 1);
      for (const line of codeOnly(readFileSync(f, "utf8")).split("\n")) {
        // Объявление и ре-экспорт — не вызовы.
        if (/\bdispatchAndAudit\(/.test(line) && !/function dispatchAndAudit/.test(line)) {
          sites.push(rel);
        }
      }
    }
    expect(sites.sort()).toEqual([
      // Гейт: единственный путь, собирающий payload через buildPayload.
      "action-dispatch.ts",
      // Апрув из Telegram — переигрывает уже собранный payload.
      "commands.ts",
      // Стоп-кран Mini App — payload зафиксирован в коде.
      "miniapp-server.ts",
      // Ретрай self-diag — единственное место, где payload пишет модель.
      "self-diag.ts",
    ]);
  });
});

describe("соседние утверждения о MAC_STOP тоже пересчитаны", () => {
  test("permissions.ts не выдаёт autonomy за единственный путь", () => {
    const s = readFileSync(join(root, "permissions.ts"), "utf8");
    // Фраза осталась, но с оговоркой: «через гейт». Без неё «только в auto»
    // читается как «другого пути нет», а он есть.
    expect(s).toContain("Через гейт мгновенно он срабатывает только в");
    const near = s.slice(s.indexOf("Через гейт мгновенно"), s.indexOf("Через гейт мгновенно") + 400);
    expect(near).toContain("/api/mac/stop");
    expect(near).toContain("requireAdmin");
  });

  test("self-diag.ts считает не обходы buildPayload, а авторов payload", () => {
    const s = readFileSync(join(root, "self-diag.ts"), "utf8");
    expect(s).not.toContain("единственная точка диспатча, минующая");
    expect(s).toContain("единственная точка диспатча, где payload пишет");
  });
});
