/**
 * Аудит 2026-08-28: аварийный стоп Mac не рисовался никогда.
 *
 * Кнопка «Остановить всё» стояла под условием `canStop && runningCount > 0`, а
 * `runningCount` считался по сессиям со статусом `running`. Такой сессии в
 * `agent_actions` не бывает:
 *
 *   • вокабуляр статусов — ровно шесть значений (lib/audit.ts:13), из них
 *     страница сама отбрасывает `pending_approval`/`forbidden`/`rate_limited`
 *     (NON_RUN), а `ok`/`error` `toMacSession` переводит в `completed`/`failed`;
 *   • единственное, что осталось бы «выполняется», — `attempted`, но его не
 *     писал никто: по всему прод-коду это слово встречалось только в самом
 *     объявлении вокабуляра и в enum схемы инструмента;
 *   • `UPDATE agent_actions` в коде не было ни одного — строка появлялась уже
 *     терминальной, `dispatchAndAudit` писал её ПОСЛЕ `await dispatchAction`.
 *
 * То есть пока запуск идёт, строки нет вовсе, а когда она появится — запуск
 * уже кончился. Кнопка, добавленная коммитом ca58aefc, была недостижима из UI
 * во всех состояниях; вдобавок она лежала внутри ветки «сессии есть», так что
 * на пустой истории её не было бы и с живым счётчиком.
 *
 * Аудит 2026-08-29 снял обе предпосылки намеренно и по другому поводу: строка
 * теперь заводится в `attempted` ДО обращения к внешнему миру и закрывается
 * `finalizeActionRow` после, чтобы смерть процесса в промежутке не оставляла
 * отправленное сообщение вовсе без следа. Побочно у панели впервые появился
 * честный «выполняется». На вывод это не влияет: гейт аварийного стопа и тогда
 * не должен был зависеть от счётчика — панель знает лишь то, что записано в
 * базе, а не то, что на самом деле крутится на Mac. Поэтому проверки ниже
 * переписаны с «никто не пишет / никто не обновляет» на «пишет и обновляет
 * ровно тот, кому положено, и только строку в полёте».
 *
 * Панель принципиально не знает, что сейчас крутится на Mac. Значит гейт у
 * аварийного стопа один — админский, тот же, что у ручки.
 *
 * Проводка проверяется чтением исходника: DOM-харнесса у Mini App нет.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ACTION_STATUSES } from "../lib/audit.ts";
import { toMacSession } from "../miniapp/src/lib/mac-session.ts";
import type { AgentAction } from "../miniapp/src/lib/types.ts";

const RAW = readFileSync(new URL("../miniapp/src/pages/Mac.tsx", import.meta.url), "utf8");
// Комментарии цитируют убранный код — проверяем исполняемый текст.
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Ровно тот набор, что страница отбрасывает как «ещё не запуск». */
const NON_RUN = new Set<string>(["pending_approval", "forbidden", "rate_limited"]);

function row(status: string): AgentAction {
  return {
    id: `a_${status}`,
    status,
    created_at: 1,
    payload: { project: "/p", prompt: "p", mode: "ask" },
    result: {},
  } as unknown as AgentAction;
}

/** Все .ts прод-кода — без тестов и без node_modules. */
function prodFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  for (const d of ["lib", "orchestrator", "tools"]) {
    walk(join(import.meta.dir, "..", d));
  }
  return out;
}

describe("предпосылки: «выполняется» не приходит из базы", () => {
  test("из вокабуляра статусов живым остаётся только `attempted`", () => {
    const live = ACTION_STATUSES.filter(
      (s) => !NON_RUN.has(s) && toMacSession(row(s)).status === "running",
    );
    expect(live).toEqual(["attempted"]);
  });

  test("`ok` и `error` — это завершение, а не запуск", () => {
    expect(toMacSession(row("ok")).status).toBe("completed");
    expect(toMacSession(row("error")).status).toBe("failed");
  });

  test("`attempted` пишет ровно один диспетчер", () => {
    const writers = prodFiles()
      .filter((p) => {
        const src = readFileSync(p, "utf8");
        if (!src.includes('"attempted"')) return false;
        // Объявление вокабуляра, enum в схеме инструмента и SQL-предикаты
        // санитара — это описание допустимых значений, а не заведение строки.
        return !p.endsWith("lib/audit.ts") && !p.endsWith("lib/tools-schema.ts");
      })
      .map((p) => p.slice(p.indexOf("/lib/") + 1));
    // Единственная точка — `dispatchAndAudit`. Появление второй означает, что
    // строку «в полёте» заводит кто-то ещё, и её жизненный цикл (кто закроет,
    // кто подберёт брошенную) надо продумывать заново.
    expect(writers).toEqual(["lib/action-dispatch.ts"]);
  });

  test("переписывают только строку в полёте — терминальную не трогает никто", () => {
    const updates: string[] = [];
    for (const p of prodFiles()) {
      const src = readFileSync(p, "utf8");
      for (const m of src.matchAll(/UPDATE\s+agent_actions[\s\S]{0,400}?(?=`)/gi)) {
        updates.push(m[0].replace(/\s+/g, " "));
      }
    }
    // Два места: закрытие своей строки по id и санитар брошенных по возрасту.
    expect(updates).toHaveLength(2);
    // Оба огорожены статусом. Без этого условия повторный вызов или санитар
    // переписали бы уже записанный результат — то есть соврали бы о том, чем
    // действие кончилось.
    for (const sql of updates) {
      expect(sql).toContain("status='attempted'");
    }
  });
});

describe("аварийный стоп доступен", () => {
  test("кнопка не зависит от счётчика активных сессий", () => {
    expect(SRC).not.toContain("runningCount > 0");
  });

  test("кнопка стоит выше ветки «сессий нет» — пустая история её не прячет", () => {
    const button = SRC.indexOf("Остановить всё");
    const branch = SRC.indexOf("sessions.length === 0 ?");
    expect(button).toBeGreaterThan(-1);
    expect(branch).toBeGreaterThan(-1);
    expect(button).toBeLessThan(branch);
  });

  test("гейт остался админским — тот же, что у ручки", () => {
    expect(SRC).toContain("canStop &&");
    expect(SRC).toMatch(/api\s*\.\s*autonomy\(\)/);
  });
});

describe("страница не утверждает того, чего не знает", () => {
  test("пустой список активных не выдаётся за «ничего не выполняется»", () => {
    expect(SRC).not.toContain("Нет активных сессий");
  });
});
