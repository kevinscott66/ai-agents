import { describe, it, expect } from "bun:test";
import { ensureChannelFooter } from "../lib/action-dispatch.ts";

const CHAT = "https://t.me/+TBw7_-wGgxRiZjQy";
const ACT = "delabs-team.notion.site";
const DELABS = "https://t.me/+GlWh_q7pcZFkNjc6";

describe("ensureChannelFooter", () => {
  it("заменяет 2-строчный футер без ссылок на канонический со ссылками", () => {
    const text = [
      "🔥 #Item: заголовок",
      "Описание пункта.",
      "",
      "💬 ЧАТ сообщества | Активности",
      "© Copyright 2023-2026 DeLabs🤑",
    ].join("\n");
    const out = ensureChannelFooter(text);
    expect(out).toContain(`[ЧАТ](${CHAT})`);
    expect(out).toContain(ACT);
    expect(out).toContain(`[DeLabs](${DELABS})`);
    // тело пункта сохранилось, дубля футера нет
    expect(out).toContain("Описание пункта.");
    expect(out.match(/Copyright/g)?.length).toBe(1);
  });

  it("заменяет 1-строчный футер на канонический", () => {
    const text = "Пост.\n\n💬 ЧАТ сообщества | Активности © Copyright 2023-2026 DeLabs🤑";
    const out = ensureChannelFooter(text);
    expect(out).toContain(`[ЧАТ](${CHAT})`);
    expect(out.match(/Copyright/g)?.length).toBe(1);
    expect(out.startsWith("Пост.")).toBe(true);
  });

  it("не навязывает футер, если его не было", () => {
    const text = "Просто пост без футера.\nВторая строка.";
    expect(ensureChannelFooter(text)).toBe(text);
  });

  it("не трогает слово «активности» в теле (не футер-строка)", () => {
    const text = "Свежие квесты, активности и обновления проектов.\nВторая строка.";
    expect(ensureChannelFooter(text)).toBe(text);
  });
});
