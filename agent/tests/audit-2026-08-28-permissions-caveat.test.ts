/**
 * Аудит 2026-08-28: Mini App выдавал право «в авто» и молчал про то, что в
 * дефолтном чате оно не сработает.
 *
 * `SEMI_AUTO_RISKY` (девять типов: SEND_MESSAGE, PIN_MESSAGE, DELETE_MESSAGE,
 * EDIT_MESSAGE, CREATE_POLL, FORWARD_MESSAGE, MAC_RUN_CLAUDE, MAC_STOP,
 * CREATE_TEAM_CHANNEL) поднимает пол до апрува во всех чатах с автономией
 * `semi_auto` — а это дефолт. То есть `smm × SEND_MESSAGE = auto` честен ровно
 * наполовину: в чате с `auto` работает как написано, в дефолтном — нет.
 *
 * Отказывать тут нельзя, поэтому для таких строк есть `grantCaveat`
 * (permissions.ts:398). `/grant` её печатает: «Оговорка: …». `POST
 * /api/permissions` — второй и единственный другой вход к той же таблице для
 * ОДНОГО действия — её не звал вовсе: 200, ячейка перекрашивается в «авто», и
 * ни строчки о том, что гейт всё равно спросит.
 *
 * В отчёт `/perms` оговорка намеренно НЕ идёт (множество большое, приписка к
 * каждой второй строке превратила бы отчёт в стену текста — commands.ts:586).
 * Mini App здесь не отчёт: это ровно тот же одиночный `/grant`, только тапом.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SEMI_AUTO_RISKY,
  evaluateGate,
  grantCaveat,
  grantIneffectiveReason,
  setAutonomy,
  setPermission,
} from "../lib/permissions.ts";
import { restoreAutonomy, saveAutonomy, savePermissions } from "./_helpers.ts";

const SERVER_SRC = readFileSync(join(import.meta.dir, "..", "lib", "miniapp-server.ts"), "utf8");
const PAGE_SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "pages", "Permissions.tsx"),
  "utf8",
);
const API_SRC = readFileSync(join(import.meta.dir, "..", "miniapp", "src", "lib", "api.ts"), "utf8");

const CHAT = -100828045;

describe("предпосылки", () => {
  test("строка «auto» на SEMI_AUTO_RISKY пишется — и не действует в дефолтном чате", () => {
    const restore = savePermissions([["smm", "SEND_MESSAGE"]]);
    // bun гоняет весь каталог одним процессом: глобальный режим автономии
    // мог остаться от соседнего файла. Ставим дефолт явно и возвращаем.
    const prevMode = saveAutonomy();
    try {
      setAutonomy("global", "*", "semi_auto");
      expect(SEMI_AUTO_RISKY.has("SEND_MESSAGE")).toBe(true);
      // Отказать нельзя: строка законна, `grantIneffectiveReason` молчит.
      expect(grantIneffectiveReason("smm", "SEND_MESSAGE", "auto")).toBeNull();
      setPermission("smm", "SEND_MESSAGE", { allowed: true, requires_approval: false });
      // А гейт в чате с дефолтной автономией всё равно отвечает approval.
      expect(
        evaluateGate({ agentKey: "smm", actionType: "SEND_MESSAGE", chatId: CHAT }).decision,
      ).toBe("approval");
    } finally {
      restoreAutonomy(prevMode);
      restore();
    }
  });

  test("оговорка на этот случай уже написана и адресна", () => {
    const caveat = grantCaveat("SEND_MESSAGE", "auto");
    expect(caveat).toContain("SEND_MESSAGE");
    expect(caveat).toContain("semi_auto");
    // Ужесточение до апрува оговорки не требует: оно действует везде.
    expect(grantCaveat("SEND_MESSAGE", "approval")).toBeNull();
    expect(grantCaveat("CREATE_TASK", "auto")).toBeNull();
  });
});

describe("маршрут возвращает оговорку", () => {
  test("POST /api/permissions зовёт grantCaveat и кладёт результат в ответ", () => {
    const route = SERVER_SRC.slice(
      SERVER_SRC.indexOf('if (path === "/api/permissions" && method === "POST")'),
      SERVER_SRC.indexOf('// /api/autonomy'),
    );
    expect(route).toContain("grantCaveat(");
    expect(route).toContain("caveat");
  });

  test("оговорка считается по тому же режиму, что и записывается", () => {
    const route = SERVER_SRC.slice(
      SERVER_SRC.indexOf('if (path === "/api/permissions" && method === "POST")'),
      SERVER_SRC.indexOf('// /api/autonomy'),
    );
    // Расхождение режима между записью и оговоркой дало бы приписку не к той
    // строке — то же расхождение, что чинил `grantIneffectiveReason`.
    expect(route.split('body.requires_approval ? "approval" : "auto"').length - 1).toBe(2);
  });

  test("grantCaveat импортирован сервером", () => {
    expect(SERVER_SRC).toContain("grantCaveat");
  });

  test("оговорка не подменяет собой отказ 409", () => {
    // Мёртвая строка по-прежнему не пишется вовсе.
    const route = SERVER_SRC.slice(
      SERVER_SRC.indexOf('if (path === "/api/permissions" && method === "POST")'),
      SERVER_SRC.indexOf('// /api/autonomy'),
    );
    expect(route).toContain("строка не подействует:");
    expect(route.indexOf("grantIneffectiveReason")).toBeLessThan(route.indexOf("setPermission("));
  });
});

describe("панель показывает оговорку человеку", () => {
  test("клиент знает про поле caveat в ответе", () => {
    expect(API_SRC).toContain("caveat");
  });

  test("страница показывает оговорку, а не глотает её", () => {
    expect(PAGE_SRC).toContain("caveat");
    expect(PAGE_SRC).toContain("toast(");
  });

  test("оговорка не выдаётся за ошибку", () => {
    // Право выдано, запись прошла: красный тост врал бы в другую сторону.
    const from = PAGE_SRC.indexOf("await api.setPermission(");
    const save = PAGE_SRC.slice(from, PAGE_SRC.indexOf("} catch", from));
    expect(save).toContain("caveat");
    expect(save).not.toContain('"error"');
  });
});

describe("оба одиночных входа к таблице ведут себя одинаково", () => {
  test("и команда, и маршрут зовут grantCaveat", () => {
    const cmds = readFileSync(join(import.meta.dir, "..", "lib", "commands.ts"), "utf8");
    expect(cmds).toContain("grantCaveat(action, mode)");
    expect(SERVER_SRC).toContain("grantCaveat(");
  });

  test("в отчёте /perms оговорки по-прежнему нет — там она была бы стеной текста", () => {
    const cmds = readFileSync(join(import.meta.dir, "..", "lib", "commands.ts"), "utf8");
    const report = cmds.slice(cmds.indexOf("const dead ="), cmds.indexOf("export function cmdAudit"));
    expect(report).not.toContain("grantCaveat(");
  });
});
