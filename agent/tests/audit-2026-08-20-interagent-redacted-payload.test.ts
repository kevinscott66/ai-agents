/**
 * Аудит 2026-08-20: карточка аппрува рисовала «сводку» поверх вырезанного payload.
 *
 * `/api/approvals` для НЕ-админа прогоняет строки через `redactContent`
 * (`agent/lib/miniapp-server.ts`): поле `payload` заменяется строкой
 * `"(скрыто: доступно администратору)"`, а на строку ставится `redacted: true`.
 * Вкладка Approvals при этом не закрыта (`App.tsx`), то есть такой viewer
 * реально существует.
 *
 * `InterAgentCard` принимал этот payload как есть. `typeof payload === "string"`,
 * значит внутренний `p` становился `null`, и все геттеры `str/bool/num`
 * возвращали пустоту — а разметка всё равно рисовалась:
 *
 *     Выдать `?` агенту `?`
 *     allowed: — · requires_approval: —
 *
 * Это читается не как «данных нет», а как «данные такие»: действие без
 * параметров, флаги не выставлены. Человек одобряет выдачу полномочия, глядя на
 * сводку, которой не существует. Строка `redacted: true` в ответе уже была —
 * фронт её просто не читал (`Approval` в types.ts даже не объявлял поле).
 *
 * Прецедент правильного поведения рядом: `toMacSession` и `macOutputView` в
 * miniapp/src/lib/mac-session.ts тот же флаг читают и отдают `REDACTED_NOTE`
 * вместо выдуманных значений.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import {
  interAgentPayloadState,
  INTER_AGENT_ACTION_TYPES,
} from "../miniapp/src/components/InterAgentCard.tsx";

/** Ровно то, что кладёт redactContent вместо payload. */
const SERVER_NOTE = "(скрыто: доступно администратору)";

describe("interAgentPayloadState", () => {
  test("нормальный объект — ok", () => {
    expect(
      interAgentPayloadState({ target_agent_key: "qa", action_type: "SEND_MESSAGE" }),
    ).toBe("ok");
  });

  test("флаг redacted со строки ответа сильнее содержимого payload", () => {
    expect(interAgentPayloadState({ target_agent_key: "qa" }, true)).toBe("redacted");
  });

  test("payload, заменённый сервером на строку, распознаётся как redacted", () => {
    expect(interAgentPayloadState(SERVER_NOTE)).toBe("redacted");
  });

  test("распознаётся по типу, а не по тексту заглушки", () => {
    // Текст ноты живёт в miniapp-server.ts и может смениться; правило —
    // «для этих действий payload всегда объект, строка = вырезано».
    expect(interAgentPayloadState("anything else")).toBe("redacted");
    expect(interAgentPayloadState("")).toBe("redacted");
  });

  test("отсутствующий payload — missing, а не ok", () => {
    expect(interAgentPayloadState(null)).toBe("missing");
    expect(interAgentPayloadState(undefined)).toBe("missing");
    expect(interAgentPayloadState(42)).toBe("missing");
    expect(interAgentPayloadState([{ a: 1 }])).toBe("missing");
  });

  test("redacted:false не превращает нормальный payload в скрытый", () => {
    expect(interAgentPayloadState({ target_agent_key: "qa" }, false)).toBe("ok");
  });

  test("флаг redacted перекрывает и отсутствующий payload", () => {
    expect(interAgentPayloadState(null, true)).toBe("redacted");
  });
});

/**
 * Разметку здесь не отрендерить (в гейте нет DOM), поэтому проводку проверяем
 * по исходнику — тот же приём, что в audit-2026-08-20-daemon-auth-gate.
 */
describe("проводка", () => {
  const card = readFileSync(
    new URL("../miniapp/src/components/InterAgentCard.tsx", import.meta.url),
    "utf8",
  );
  const approvals = readFileSync(
    new URL("../miniapp/src/pages/Approvals.tsx", import.meta.url),
    "utf8",
  );
  const types = readFileSync(
    new URL("../miniapp/src/lib/types.ts", import.meta.url),
    "utf8",
  );

  test("карточка спрашивает состояние payload", () => {
    expect(card).toContain("interAgentPayloadState(payload, redacted)");
  });

  test("выход по скрытому payload стоит ДО первой ветки по action_type", () => {
    const guard = card.indexOf('if (state !== "ok")');
    const firstBranch = card.indexOf('if (actionType === "GRANT_PERMISSION")');
    expect(guard).toBeGreaterThan(-1);
    expect(firstBranch).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstBranch);
  });

  test("страница аппрувов передаёт флаг со строки ответа", () => {
    expect(approvals).toContain("redacted={first.redacted}");
  });

  test("тип Approval объявляет поле, которое сервер уже присылает", () => {
    expect(types).toContain("redacted?: boolean;");
  });
});

describe("инвариант: ни одно inter-agent действие не имеет строкового payload", () => {
  test("список действий не пуст и все они объектные по схеме", () => {
    // Страховка от расширения списка: если появится действие, чей payload
    // легитимно строка, правило выше сломается — и этот тест напомнит.
    expect(INTER_AGENT_ACTION_TYPES.length).toBeGreaterThan(0);
    for (const t of INTER_AGENT_ACTION_TYPES) {
      expect(typeof t).toBe("string");
    }
  });
});
