/**
 * Аудит 2026-08-13, живая область раздела «Дайджесты». Все три дефекта заметны
 * только на слух, поэтому глазами их и не ловили — подробности в `announce.ts`.
 */
import { describe, expect, test } from "bun:test";
import { digestsAnnouncement, type AnnounceInput } from "./announce";

const base: AnnounceInput = {
  status: "success",
  query: "",
  shown: 6,
  total: 6,
  hasMore: false,
  interacted: true,
};
const say = (over: Partial<AnnounceInput> = {}) =>
  digestsAnnouncement({ ...base, ...over });

describe("до первого действия область молчит", () => {
  test("открытие страницы ничего не зачитывает", () => {
    expect(say({ interacted: false, status: "loading" })).toBe("");
    expect(say({ interacted: false })).toBe("");
  });

  test("ссылка с готовым запросом — тоже исходное состояние, не событие", () => {
    expect(say({ interacted: false, query: "Monad", total: 12 })).toBe("");
  });

  test("после действия область снова говорит", () => {
    expect(say({ status: "loading" })).toBe("Загрузка дайджестов");
  });
});

describe("поиск сообщает размер выдачи, а не размер страницы", () => {
  test("40 совпадений при странице в 6 — это сорок, а не шесть", () => {
    // Ровно на этом числе человек решает, уточнять запрос или нет. Раньше здесь
    // стояло `shown`, то есть звучало «найдено дайджестов: 6».
    const s = say({ query: "Base", shown: 6, total: 40, hasMore: true });
    expect(s).toContain("40");
    expect(s).not.toContain(": 6");
  });

  test("пустая выдача названа пустой", () => {
    expect(say({ query: "квантовый нарратив", shown: 0, total: 0 })).toBe(
      "По запросу «квантовый нарратив» ничего не найдено",
    );
  });

  test("найдено не бывает меньше показанного", () => {
    // Счётчики разной природы: `shown` копится на клиенте, `total` приходит с
    // каждым ответом заново. Между страницами запись могли удалить.
    const s = say({ query: "Base", shown: 6, total: 4 });
    expect(s).toContain("6");
    expect(s).not.toContain("4");
  });

  test("склонение по числу, а не «1 дайджестов»", () => {
    expect(say({ query: "x", shown: 1, total: 1 })).toContain("1 дайджест");
    expect(say({ query: "x", shown: 2, total: 2 })).toContain("2 дайджеста");
    expect(say({ query: "x", shown: 5, total: 5 })).toContain("5 дайджестов");
  });
});

describe("«показано N из M» не выдаёт невозможных чисел", () => {
  test("«из total» только когда есть что догружать", () => {
    expect(say({ shown: 6, total: 40, hasMore: true })).toContain("6 из 40");
  });

  test("всё загружено — второго числа нет вовсе", () => {
    // «Показано 6 из 6» — шум: второе число ничего не добавляет.
    const s = say({ shown: 6, total: 6, hasMore: false });
    expect(s).not.toContain("из");
    expect(s).toContain("это все");
  });

  test("разъехавшиеся счётчики не дают «6 из 4»", () => {
    // Удалили запись между двумя страницами: shown=6, total=4, догружать нечего.
    const s = say({ shown: 6, total: 4, hasMore: false });
    expect(s).not.toContain("из 4");
    expect(s).toContain("6");
  });

  test("пустой список без запроса молчит — о нём говорит empty state", () => {
    expect(say({ shown: 0, total: 0 })).toBe("");
  });
});

describe("состояния загрузки", () => {
  test("ошибка названа ошибкой", () => {
    expect(say({ status: "error" })).toBe("Не удалось загрузить дайджесты");
  });

  test("догрузка следующей страницы не выдаёт себя за первую загрузку", () => {
    // status "more" — это клик по «Показать ещё»; список на экране остаётся,
    // и «Загрузка дайджестов» здесь сбивала бы с толку.
    expect(say({ status: "more", shown: 6, total: 40, hasMore: true })).toContain(
      "6 из 40",
    );
  });
});
