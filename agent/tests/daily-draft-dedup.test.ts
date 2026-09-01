/**
 * Дедуп новостей в daily-draft: постовик не должен повторять уже опубликованную
 * новость (баг «зациклился на увольнениях Ethereum Foundation»).
 */
import { test, expect, describe } from "bun:test";
import { isDuplicate } from "../tools/daily-draft.ts";

const PUBLISHED = [
  "Ethereum Foundation уволила 54 человека и режет бюджет на 40%",
  "Binance рискует потерять доступ к ЕС по MiCA",
];

describe("daily-draft isDuplicate", () => {
  test("точный повтор → дубль", () => {
    expect(
      isDuplicate("Ethereum Foundation уволила 54 человека и режет бюджет на 40%", PUBLISHED),
    ).toBe(true);
  });

  test("перефразировка той же новости → дубль (≥2 общих значимых слова)", () => {
    expect(
      isDuplicate("Ethereum Foundation сокращает штат: уволено 54 сотрудника", PUBLISHED),
    ).toBe(true);
  });

  test("другая новость про Ethereum, но иная тема → НЕ дубль", () => {
    expect(isDuplicate("Ethereum готовит апгрейд Glamsterdam", PUBLISHED)).toBe(false);
  });

  test("совсем другая новость → не дубль", () => {
    expect(isDuplicate("Solana ETF собрал $500 млн за день", PUBLISHED)).toBe(false);
  });

  test("разные новости с общими филлерами → НЕ дубль (стоп-лист)", () => {
    const pub = ["Binance запускает стейкинг ETH на бирже"];
    // общие слова «запускает»/«стейкинг»/«бирже» — филлеры, не считаются
    expect(isDuplicate("Coinbase запускает стейкинг SOL на бирже", pub)).toBe(false);
  });

  test("пустой список опубликованного → ничего не дубль", () => {
    expect(isDuplicate("любой заголовок", [])).toBe(false);
  });

  test("регистр и пунктуация игнорируются", () => {
    expect(
      isDuplicate("BINANCE рискует потерять доступ к ЕС — по MiCA!", PUBLISHED),
    ).toBe(true);
  });
});
