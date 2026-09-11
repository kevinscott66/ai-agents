/**
 * Аудит 2026-09-11: WEB_SEARCH_MAX_USES=3 стоил как пятнадцать таких лимитов.
 *
 * `max_uses` у серверного инструмента Anthropic действует на ОДИН HTTP-запрос,
 * а `runWithTools` приклеивал свежий `webSearchTool()` перед каждым запросом
 * цикла — до MAX_TOOL_ITERS штук — плюс к финализирующему. Каждый запрос
 * получал новый нетронутый счётчик, то есть фактический потолок прогона был
 * `WEB_SEARCH_MAX_USES × 15`: при дефолте 45 поисков вместо трёх.
 *
 * Усугубляла пауза. `pause_turn` порождает именно серверный веб-поиск, и цикл
 * на ней идёт дальше — значит каждая пауза гарантированно превращалась в
 * новый запрос с новым бюджетом. Комментарий у этой ветки закрывал вопрос
 * зацикливания («цикл всё равно ограничен MAX_TOOL_ITERS») и молчал о деньгах,
 * а шапка файла вовсе утверждала, что цикл прерывается на любом stop_reason,
 * кроме tool_use.
 *
 * Ни `token-budget.ts` (там только токены), ни бакеты `rate-limits.ts` поисков
 * не считают — перерасход не был виден нигде, кроме счёта у владельца.
 * Единственная опора — `usage.server_tool_use.web_search_requests`, по нему
 * считает и биллинг.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { runWithTools } from "../lib/tool-loop.ts";
import { webSearchTool, webSearchRequestsUsed } from "../lib/web-search.ts";

const ENABLED = "WEB_SEARCH_ENABLED";
const MAX = "WEB_SEARCH_MAX_USES";
let prevEnabled: string | undefined;
let prevMax: string | undefined;

beforeEach(() => {
  prevEnabled = process.env[ENABLED];
  prevMax = process.env[MAX];
  process.env[ENABLED] = "true";
  process.env[MAX] = "3";
});
afterEach(() => {
  if (prevEnabled === undefined) delete process.env[ENABLED];
  else process.env[ENABLED] = prevEnabled;
  if (prevMax === undefined) delete process.env[MAX];
  else process.env[MAX] = prevMax;
});

const base = {
  model: "t",
  system: [{ type: "text" as const, text: "s" }],
  messages: [{ role: "user" as const, content: "найди что-нибудь" }],
  agentKey: "orchestrator",
  chatId: -1,
};

/** Что назвал каждый запрос: сколько поисков ему разрешили. */
type Seen = { maxUses: number | null; isFinal: boolean; choice: string | null };

/**
 * Модель, которая на каждой итерации тратит `spend` поисков и просит
 * несуществующий инструмент (executeTool отбивает его до диспатчера, побочных
 * эффектов нет) — цикл гарантированно доходит до предела раундов.
 */
function searcher(spend: number, seen: Seen[], stop: "tool_use" | "pause_turn") {
  return {
    messages: {
      create: async (req: any) => {
        const ws = (req.tools ?? []).find(
          (t: any) => t.type === "web_search_20250305",
        );
        const isFinal = req.tool_choice?.type === "none" || !req.tools;
        seen.push({
          maxUses: ws ? ws.max_uses : null,
          isFinal,
          choice: req.tool_choice?.type ?? null,
        });
        const usage = {
          input_tokens: 0,
          output_tokens: 0,
          server_tool_use: { web_search_requests: spend },
        };
        if (isFinal) {
          return {
            id: "m", type: "message", role: "assistant", model: "t",
            stop_reason: "end_turn", stop_sequence: null, usage,
            content: [{ type: "text", text: "итог" }],
          } as unknown as Anthropic.Message;
        }
        return {
          id: "m", type: "message", role: "assistant", model: "t",
          stop_reason: stop, stop_sequence: null, usage,
          content:
            stop === "pause_turn"
              ? [{ type: "text", text: "" }]
              : [
                  { type: "text", text: "" },
                  { type: "tool_use", id: "tu", name: "NO_SUCH_TOOL", input: {} },
                ],
        } as unknown as Anthropic.Message;
      },
    },
  } as unknown as Anthropic;
}

describe("бюджет веб-поиска считается на прогон, а не на запрос", () => {
  test("остаток убывает от запроса к запросу", async () => {
    const seen: Seen[] = [];
    await runWithTools({ ...base, anthropic: searcher(1, seen, "tool_use") } as never);

    const inLoop = seen.filter((s) => !s.isFinal);
    expect(inLoop.length).toBeGreaterThan(3);
    // Первому дали три, следующим — на потраченное меньше.
    expect(inLoop[0]!.maxUses).toBe(3);
    expect(inLoop[1]!.maxUses).toBe(2);
    expect(inLoop[2]!.maxUses).toBe(1);
    // Дальше остаток нулевой — инструмент не приклеивается вовсе.
    for (const s of inLoop.slice(3)) expect(s.maxUses).toBeNull();
  });

  test("сумма разрешённого за прогон не превышает лимит", async () => {
    const seen: Seen[] = [];
    await runWithTools({ ...base, anthropic: searcher(1, seen, "tool_use") } as never);
    // Считаем по запросам, в которых вызов вообще возможен. До правки это была
    // сумма 3 × (число запросов) — не меньше 42.
    const granted = seen
      .filter((s) => !s.isFinal)
      .reduce((n, s) => n + (s.maxUses ?? 0), 0);
    expect(granted).toBeLessThanOrEqual(3 + 2 + 1);
    // Финализирующий запрос в эту сумму не входит по праву, а не по недосмотру:
    // определение инструмента там нужно, чтобы API принял server_tool_use-блоки
    // из истории, а звать его заново запрещает `tool_choice:"none"`.
    const final = seen.filter((s) => s.isFinal);
    expect(final.length).toBe(1);
    expect(final[0]!.choice).toBe("none");
  });

  test("паузы серверного поиска бюджет не обнуляют", async () => {
    // `pause_turn` — это ровно тот stop_reason, который ставит сам веб-поиск,
    // и цикл на нём продолжается. Именно здесь набегал лишний счёт.
    const seen: Seen[] = [];
    await runWithTools({ ...base, anthropic: searcher(3, seen, "pause_turn") } as never);
    const inLoop = seen.filter((s) => !s.isFinal);
    expect(inLoop[0]!.maxUses).toBe(3);
    // Три потрачено на первом же запросе — больше не даём ни одного.
    for (const s of inLoop.slice(1)) expect(s.maxUses).toBeNull();
  });

  test("финализирующий вызов идёт с остатком, а не со свежим бюджетом", async () => {
    const seen: Seen[] = [];
    await runWithTools({ ...base, anthropic: searcher(3, seen, "tool_use") } as never);
    const final = seen.filter((s) => s.isFinal);
    expect(final.length).toBe(1);
    // Свежих трёх финализатору не выдают: бюджет прогона уже израсходован.
    expect(final[0]!.maxUses).toBe(1);
  });
});

/**
 * Вторая половина той же правки, найденная перечитыванием: нулевой остаток
 * значит ДВЕ разные вещи, а код обрабатывал их одинаково.
 *
 * `webSearchTool(0)` возвращает null — и это верно в цикле, где ноль значит
 * «больше нельзя». Но финализирующий запрос шлёт ту же историю сообщений, в
 * которой лежат server_tool_use-блоки отработавшего поиска, а запрос с такими
 * блоками и без определения инструмента API отбивает 400 — тем же способом,
 * каким отбивал запрос вовсе без `tools` (см. комментарий у finalReq). То есть
 * прогон, потративший весь бюджет, гарантированно терял финализацию и
 * заканчивался заглушкой «(достигнут предел шагов…)» — ровно тем, ради
 * устранения чего финализация и существует. Новых поисков определение при
 * этом не разрешает: `tool_choice:"none"`.
 */
describe("нулевой остаток: «не было бюджета» и «бюджет потрачен» — разное", () => {
  test("поиск не запускался ни разу — определения в финале нет", async () => {
    process.env[MAX] = "0";
    const seen: Seen[] = [];
    await runWithTools({ ...base, anthropic: searcher(0, seen, "tool_use") } as never);
    // Бюджета не было с самого начала: ни в цикле, ни в финале приклеивать
    // нечего, и server_tool_use-блоков в истории тоже неоткуда взяться.
    for (const s of seen) expect(s.maxUses).toBeNull();
  });

  test("бюджет цел, поисков не было — финал получает остаток как есть", async () => {
    const seen: Seen[] = [];
    await runWithTools({ ...base, anthropic: searcher(0, seen, "tool_use") } as never);
    const final = seen.filter((s) => s.isFinal);
    expect(final.length).toBe(1);
    expect(final[0]!.maxUses).toBe(3);
  });

  test("бюджет израсходован — определение всё равно уезжает", async () => {
    const seen: Seen[] = [];
    // Первый же запрос выбирает весь бюджет; дальше цикл идёт без поиска.
    await runWithTools({ ...base, anthropic: searcher(3, seen, "pause_turn") } as never);
    const inLoop = seen.filter((s) => !s.isFinal);
    for (const s of inLoop.slice(1)) expect(s.maxUses).toBeNull();
    const final = seen.filter((s) => s.isFinal);
    expect(final.length).toBe(1);
    // Не null: в истории лежат server_tool_use-блоки, без определения запрос
    // не пройдёт. Минимальная единица — потому что тратить всё равно нечего.
    expect(final[0]!.maxUses).toBe(1);
  });
});

describe("детали учёта", () => {
  test("webSearchTool(0) инструмента не отдаёт", () => {
    expect(webSearchTool(0)).toBeNull();
    expect(webSearchTool(-5)).toBeNull();
    expect(webSearchTool(2)?.max_uses).toBe(2);
    // Без аргумента — прежнее поведение «на запрос», из env.
    expect(webSearchTool()?.max_uses).toBe(3);
  });

  test("счётчик читается из usage, а мусор считается нулём", () => {
    expect(webSearchRequestsUsed({ usage: { server_tool_use: { web_search_requests: 4 } } })).toBe(4);
    expect(webSearchRequestsUsed({ usage: { server_tool_use: null } })).toBe(0);
    expect(webSearchRequestsUsed({ usage: null })).toBe(0);
    expect(webSearchRequestsUsed({})).toBe(0);
    expect(
      webSearchRequestsUsed({
        usage: { server_tool_use: { web_search_requests: -1 } },
      }),
    ).toBe(0);
  });
});
