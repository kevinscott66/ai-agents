/**
 * Аудит 2026-08-11: обложка не должна стоить публикации.
 *
 * В PUBLISH_TO_CHANNEL картинка — украшение: смысл поста в тексте, который к
 * этому моменту уже прошёл всю цепочку (черновик → апрув человеком → футер →
 * подгонка под лимит). Но получение обложки стояло на критическом пути без
 * всякой защиты:
 *
 *   coverBuf = await generateCoverPng(p.coverPrompt, ctx.agentKey);
 *
 * `generateCoverPng` перехватывает ТОЛЬКО quota/billing (там SVG-фолбэк). Всё
 * остальное летит наружу: нет OPENAI_API_KEY, промпт длиннее 4000, таймаут
 * сокета, 500 от OpenAI, отказ модерации. Дальше — общий `catch` хендлера,
 * `{ok:false}`, и пост не уходит ВООБЩЕ. Апрув при этом уже потрачен: чтобы
 * повторить, человек должен подтверждать заново.
 *
 * Тот же путь у авто-баннера (ветка «агент не дал обложку» — она же дефолтная
 * для каждого поста): `renderBannerPng` внутри `renderCoverBanner` тоже может
 * упасть, и тогда падает публикация.
 *
 * Правильный размен очевиден: пост без картинки хуже поста с картинкой, но
 * несравнимо лучше отсутствия поста. Проверяем, что провал обложки деградирует
 * до публикации без запрошенной картинки, а не отменяет её.
 *
 * Аудит 2026-08-20 — деградация стала на ступень мягче. Ветка «превью
 * обязательно, рисуем авто-баннер» стояла только на пути «агент не дал обложку
 * вовсе»; агент, который обложку ДАЛ, но её не удалось получить, проваливался
 * мимо неё в пост без превью. То есть пост наказывался за то, что автор передал
 * БОЛЬШЕ данных, — при том что рендер баннера локальный: ни OpenAI, ни Claude,
 * ни ролевого инструмента. Теперь сбой обложки уходит в тот же локальный
 * баннер, и «пост всегда = баннер + текст» держится на всех путях. Инвариант
 * этого файла не изменился: ok:true, ровно одно сообщение, текст на месте.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { dispatchAction } from "../lib/action-dispatch.ts";
import { registerTeamChannel } from "../lib/team-channels.ts";
import { db } from "../lib/db.ts";

const CH = -100778;

type Sent = { kind: "message" | "photo"; chatId: number; text?: string };

const fakeTg = () => {
  const sent: Sent[] = [];
  return {
    sent,
    tg: {
      sendMessage: (chatId: number, text: string) => {
        sent.push({ kind: "message", chatId, text });
        return Promise.resolve({ message_id: 1 });
      },
      sendPhoto: (chatId: number, _photo: unknown, extra: { caption?: string }) => {
        sent.push({ kind: "photo", chatId, text: extra?.caption });
        return Promise.resolve({ message_id: 2 });
      },
    } as any,
  };
};

/**
 * Роль по умолчанию — `design`, и это существенно: с 2026-08-13 `coverPrompt`
 * ведёт к платному растру только у ролей, которым выдан GENERATE_IMAGE
 * (`design`, `orchestrator`). Оставь здесь `smm` — и обе проверки ниже стали бы
 * вакуумными: до сбоя OpenAI управление просто не доходит, роль уходит в
 * SVG-фолбэк, и защита от инцидента 2026-08-11 перестала бы что-либо стеречь.
 */
const publish = async (
  payload: Record<string, unknown>,
  sentTg: ReturnType<typeof fakeTg>,
  agentKey = "design",
) =>
  await dispatchAction(
    "PUBLISH_TO_CHANNEL",
    { channelId: CH, ...payload } as any,
    { agentKey, chatId: -1, telegram: sentTg.tg } as any,
  );

describe("PUBLISH_TO_CHANNEL: провал обложки не отменяет пост", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM team_channels WHERE channel_id = ?").run(CH);
    registerTeamChannel(CH, "Team Ch", -1);
  });

  test("нет OPENAI_API_KEY → пост уходит с локальным баннером", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const f = fakeTg();
      const out = await publish(
        { text: "**Крючок.** Живой пост про аирдропы.", coverPrompt: "neon web3 banner" },
        f,
      );
      expect(out.ok).toBe(true);
      expect(f.sent.length).toBe(1);
      expect(f.sent[0].kind).toBe("photo");
      expect(f.sent[0].text ?? "").toContain("Живой пост");
    } finally {
      if (saved === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved;
    }
  });

  test("промпт обложки длиннее 4000 → пост уходит с локальным баннером", async () => {
    // Ошибка валидации промпта, без сети и без ключа: тот же класс отказа, что
    // таймаут или 500, но воспроизводится одинаково в любом окружении.
    const f = fakeTg();
    const out = await publish(
      { text: "**Крючок.** Второй живой пост.", coverPrompt: "x".repeat(4100) },
      f,
    );
    expect(out.ok).toBe(true);
    expect(f.sent.length).toBe(1);
    expect(f.sent[0].kind).toBe("photo");
    expect(f.sent[0].text ?? "").toContain("Второй живой пост");
  });

  test("исправная обложка по-прежнему уходит фотографией", async () => {
    // Страховка от «починили деградацию, заодно выключили картинки»: без
    // явной обложки хендлер обязан сам нарисовать авто-баннер.
    const f = fakeTg();
    const out = await publish({ text: "**Крючок.** Пост с авто-баннером." }, f);
    expect(out.ok).toBe(true);
    expect(f.sent.length).toBe(1);
    expect(f.sent[0].kind).toBe("photo");
  });
});
