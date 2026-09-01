/**
 * Аудит 2026-08-20: ролевой гейт на обложке был декоративным, и обход был
 * бесплатным.
 *
 * Фикс 2026-08-13 закрыл маршрут «роль без GENERATE_IMAGE дотягивается до
 * растра через coverPrompt соседнего действия»: `smm`/`copy` стали уходить в
 * SVG-фолбэк. Но `ROLE_EXPOSED_TOOLS.GENERATE_SVG_IMAGE` — ТОТ ЖЕ список
 * `["design","orchestrator"]`. То есть гейт закрывал OpenAI и тут же отдавал
 * Claude: роль получала ровно то, что фикс закрывал, только другим движком.
 *
 * Второе: `return` в этой ветке стоял ДО `checkAndConsumeRateLimit`. `design`
 * платил 6 слотов в час, обходной маршрут — ноль. Бакет заведён потому, что
 * «деньги тратятся здесь»; запрос к Claude за SVG — те же деньги.
 *
 * Третье (следствие фикса, а не отдельная находка): отказ роли не должен
 * стоить посту превью. Ветка «превью обязательно, рисуем авто-баннер» стояла
 * только на пути «агент не дал обложку вовсе» — а рендер этот локальный, без
 * LLM и без ролевых инструментов. Теперь любой сбой обложки уходит туда же.
 */
import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import { generateCoverPng } from "../lib/dispatch/media.ts";
import { isToolExposedToRole } from "../lib/permissions.ts";
import { _resetRateLimits, checkRateLimit } from "../lib/rate-limits.ts";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { registerTeamChannel } from "../lib/team-channels.ts";
import { db } from "../lib/db.ts";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>`;

afterEach(() => _resetRateLimits());

function deps() {
  const calls = { paid: 0, cheap: 0 };
  return {
    calls,
    deps: {
      generate: async () => {
        calls.paid++;
        return Buffer.from("png");
      },
      fallbackSvg: async () => {
        calls.cheap++;
        return SVG;
      },
    },
  };
}

describe("SVG-фолбэк — тоже ролевой инструмент", () => {
  test("предпосылка: оба инструмента выданы одному и тому же списку ролей", () => {
    for (const role of ["smm", "copy"]) {
      expect(isToolExposedToRole("PUBLISH_TO_CHANNEL", role)).toBe(true);
      expect(isToolExposedToRole("GENERATE_IMAGE", role)).toBe(false);
      // Вот из-за этой строки прежний фолбэк и был обходом, а не деградацией.
      expect(isToolExposedToRole("GENERATE_SVG_IMAGE", role)).toBe(false);
    }
    for (const role of ["design", "orchestrator"]) {
      expect(isToolExposedToRole("GENERATE_IMAGE", role)).toBe(true);
      expect(isToolExposedToRole("GENERATE_SVG_IMAGE", role)).toBe(true);
    }
  });

  for (const role of ["smm", "copy"]) {
    test(`${role}: ни платной генерации, ни дешёвой — отказ с внятной причиной`, async () => {
      const { calls, deps: d } = deps();
      await expect(generateCoverPng("промпт", role, d)).rejects.toThrow(
        /не выдан ни GENERATE_IMAGE, ни GENERATE_SVG_IMAGE/,
      );
      expect(calls.paid).toBe(0);
      expect(calls.cheap).toBe(0);
    });
  }

  test("design: растр как был, слот списан", async () => {
    const { calls, deps: d } = deps();
    expect((await generateCoverPng("промпт", "design", d)).toString()).toBe("png");
    expect(calls.paid).toBe(1);
    expect(calls.cheap).toBe(0);
  });

  test("design с исчерпанным бюджетом по-прежнему деградирует в SVG, а не падает", async () => {
    const { calls, deps: d } = deps();
    for (let k = 0; k < 7; k++) await generateCoverPng("промпт", "design", d);
    // 6 слотов в час: седьмой вызов уходит в фолбэк, а не в исключение.
    expect(calls.paid).toBe(6);
    expect(calls.cheap).toBe(1);
  });
});

describe("бюджет картинок считается на обоих маршрутах", () => {
  test("роль без обоих инструментов бакет не трогает — отказ это не расход", async () => {
    const { deps: d } = deps();
    await generateCoverPng("промпт", "smm", d).catch(() => {});
    expect(checkRateLimit("smm", "GENERATE_IMAGE").ok).toBe(true);
  });

  test("SVG-маршрут списывает слот там, где раньше проходил бесплатно", async () => {
    // Прямая проверка порядка: у роли с выданным SVG, но без растра, слот
    // должен уйти. Такой роли сейчас нет, поэтому меряем на design через
    // исчерпание — бакет обязан дойти до нуля, а не остаться нетронутым.
    const { deps: d } = deps();
    for (let k = 0; k < 6; k++) await generateCoverPng("промпт", "design", d);
    expect(checkRateLimit("design", "GENERATE_IMAGE").ok).toBe(false);
  });
});

describe("отказ по роли не стоит посту превью", () => {
  const CH = -100779;
  type Sent = { kind: "message" | "photo"; text?: string };
  const fakeTg = () => {
    const sent: Sent[] = [];
    return {
      sent,
      tg: {
        sendMessage: (_c: number, text: string) => {
          sent.push({ kind: "message", text });
          return Promise.resolve({ message_id: 1 });
        },
        sendPhoto: (_c: number, _p: unknown, extra: { caption?: string }) => {
          sent.push({ kind: "photo", text: extra?.caption });
          return Promise.resolve({ message_id: 2 });
        },
      } as any,
    };
  };

  beforeEach(() => {
    db.prepare("DELETE FROM team_channels WHERE channel_id = ?").run(CH);
    registerTeamChannel(CH, "Team Ch", -1);
  });

  test("smm с coverPrompt: пост уходит, с локальным баннером, одним сообщением", async () => {
    const f = fakeTg();
    const out = await dispatchAction(
      "PUBLISH_TO_CHANNEL",
      { channelId: CH, text: "**Крючок.** Пост от smm.", coverPrompt: "neon web3" } as any,
      { agentKey: "smm", chatId: -1, telegram: f.tg } as any,
    );
    expect(out.ok).toBe(true);
    expect(f.sent.length).toBe(1);
    expect(f.sent[0].kind).toBe("photo");
    expect(f.sent[0].text ?? "").toContain("Пост от smm");
  });
});
