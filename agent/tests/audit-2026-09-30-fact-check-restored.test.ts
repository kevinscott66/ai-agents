/**
 * Аудит 2026-09-30: сверка с первоисточниками вернулась в git.
 *
 * Что нашли. `lib/fact-check.ts` — 564 строки, работающие на проде с 25.09 —
 * не существовал НИ В ОДНОЙ ветке, ни в одном коммите и ни в одном dangling
 * blob репозитория. Прод собран не из `main`, и сверка попала туда мимо
 * истории. Отдельно опасно то, что `deploy/deploy.sh` — это rsync без
 * `--delete`: полная выкатка `main` файл бы не удалила, но заменила бы
 * `tools/daily-draft.ts` версией, которая его не импортирует. Проверка фактов
 * перед публикацией исчезла бы молча, а «файл же на месте» ничего не доказывает.
 *
 * Поэтому здесь не «тесты на новый модуль», а страховка от повторения: код
 * восстановлен в репозиторий, и теперь у него есть покрытие, которого на проде
 * не было вовсе. Всё проверяемое — чистое либо с подменяемыми зависимостями:
 * ни один тест в сеть не ходит и SDK не поднимает.
 */
import { describe, expect, test } from "bun:test";
import {
  attributions,
  blocking,
  factCheck,
  fixNote,
  fullText,
  linkProblems,
  openedCount,
  parseProblems,
  passed,
  quotedFragments,
  tweetRef,
  verdictFrom,
  verdictLine,
  type Checkable,
  type FactProblem,
  type LinkStatus,
} from "../lib/fact-check.ts";
import {
  buildDraftReviewText,
  looksLikeRefusal,
  vetArticles,
  type DraftArticle,
} from "../tools/daily-draft.ts";

describe("фактчекер: что уезжает проверяющему в промпт", () => {
  test("прямая речь выдёргивается отдельно от модели", () => {
    const q = quotedFragments(
      'Глава фонда сказал: «мы выкупим весь флоат до конца года», а тикер "ARC" тут не цитата.',
    );
    expect(q).toEqual(["мы выкупим весь флоат до конца года"]);
  });

  test("кавычки без пробела внутри — название, а не чьи-то слова", () => {
    expect(quotedFragments("протокол «Hyperliquid» и токен «HYPE»")).toEqual([]);
  });

  test("одна и та же цитата не дублируется", () => {
    const text = "«обещали листинг в течение недели» … и снова «обещали листинг в течение недели»";
    expect(quotedFragments(text)).toHaveLength(1);
  });

  test("обороты со ссылкой на авторитет собираются целиком", () => {
    // Ровно так в аудите 23.09 Solana попала в пресс-релиз Standard Chartered,
    // где её нет, а «по данным Reuters» было приписано агентству без основания.
    const a = attributions("По данным Reuters, фонд вышел. Standard Chartered заявил об обратном.");
    expect(a).toContain("По данным Reuters");
    expect(a.some((s) => s.startsWith("Standard Chartered заявил"))).toBe(true);
  });

  test("текст материала — заголовок, лид и тело либо интро", () => {
    expect(fullText({ title: "Т", summary: "С", body: "Б" })).toBe("Т\n\nС\n\nБ");
    expect(fullText({ title: "Т", intro: "И" })).toBe("Т\n\nИ");
  });
});

describe("ссылки: живость проверяем без модели", () => {
  test("запись в X узнаётся по числовому id, профиль — нет", () => {
    expect(tweetRef("https://x.com/hotstuff/status/1839300000000000000")).toEqual({
      user: "hotstuff",
      id: "1839300000000000000",
    });
    expect(tweetRef("https://x.com/hotstuff")).toBeNull();
    expect(tweetRef("https://example.com/status/12345")).toBeNull();
  });

  test("404 блокирует, 403 и молчание — только замечание", () => {
    const statuses: LinkStatus[] = [
      { url: "https://a.test/gone", status: 404, ok: false },
      { url: "https://b.test/paywall", status: 403, ok: false },
      { url: "https://c.test/dns", status: 0, ok: false },
      { url: "https://d.test/ok", status: 200, ok: true },
    ];
    const p = linkProblems(statuses);
    expect(p.map((x) => [x.claim, x.severity])).toEqual([
      ["https://a.test/gone", "block"],
      ["https://b.test/paywall", "warn"],
      ["https://c.test/dns", "warn"],
    ]);
  });

  test("источник, прочитанный служебным маршрутом, замечанием не считается", () => {
    // x.com отдаёт фронтенду 402, но текст записи редакция положила в промпт —
    // утверждение прикрыто, и строка «читателю не откроется» здесь шум.
    const statuses: LinkStatus[] = [{ url: "https://x.com/p/status/1", status: 402, ok: false }];
    expect(linkProblems(statuses, [{ url: "https://x.com/p/status/1", text: "текст" }])).toEqual([]);
  });
});

describe("разбор ответа проверяющего", () => {
  test("незнакомая severity трактуется как блокирующая", () => {
    const p = parseProblems({
      problems: [
        { claim: "а", issue: "и", severity: "critical" },
        { claim: "б", issue: "и", severity: "warning" },
        { claim: "в", issue: "и", severity: "note" },
        { claim: "г", issue: "и" },
      ],
    });
    expect(p.map((x) => x.severity)).toEqual(["block", "warn", "warn", "block"]);
  });

  test("источником считается только http(s)-ссылка", () => {
    const [withUrl, withJunk] = parseProblems({
      problems: [
        { claim: "а", issue: "и", source: "https://ok.test" },
        { claim: "б", issue: "и", source: "пресс-релиз" },
      ],
    });
    expect(withUrl!.source).toBe("https://ok.test");
    expect(withJunk!.source).toBeUndefined();
  });

  test("пустые строки претензией не считаются", () => {
    expect(parseProblems({ problems: [{}, { claim: "", issue: "" }, null] })).toEqual([]);
    expect(parseProblems({})).toEqual([]);
  });

  test("в открытые источники попадают только ссылки", () => {
    expect(openedCount({ sources_opened: ["https://a.test", "не ссылка", 7] })).toBe(1);
    expect(openedCount({})).toBe(0);
  });
});

describe("вердикт: молчание проверяющего — не «всё в порядке»", () => {
  const article: Checkable = {
    title: "Фонд выкупил флоат",
    items: [{ text: "пресс-релиз", url: "https://a.test" }],
  };

  test("«претензий нет» без единого открытого источника блокирует", () => {
    // Ради этого правила модуль и написан: агент, упёршийся в лимит ходов,
    // тоже вернёт «проблем нет».
    const v = verdictFrom({ problems: [] }, [{ url: "https://a.test", status: 200, ok: true }], article);
    expect(passed(v)).toBe(false);
    expect(blocking(v.problems)[0]!.issue).toContain("не открыл ни одного источника");
  });

  test("материал без ссылок блокируется отдельной претензией", () => {
    const v = verdictFrom({ problems: [], sources_opened: ["https://a.test"] }, [], {
      title: "Без источников",
      items: [],
    });
    expect(blocking(v.problems)[0]!.issue).toContain("нет ни одного источника");
  });

  test("прочитанный служебным маршрутом источник идёт в зачёт открытых", () => {
    const v = verdictFrom(
      { problems: [] },
      [{ url: "https://x.com/p/status/1", status: 402, ok: false }],
      { title: "Т", items: [{ text: "пост", url: "https://x.com/p/status/1" }] },
      [{ url: "https://x.com/p/status/1", text: "текст записи" }],
    );
    expect(v.opened).toBe(1);
    expect(passed(v)).toBe(true);
  });

  test("проверка состоялась и претензий нет — материал проходит", () => {
    const v = verdictFrom(
      { problems: [], sources_opened: ["https://a.test"] },
      [{ url: "https://a.test", status: 200, ok: true }],
      article,
    );
    expect(passed(v)).toBe(true);
    expect(verdictLine(v)).toBe("сверено по 1 источник(ам), претензий нет");
  });

  test("строка журнала считает блокирующие и замечания отдельно", () => {
    const problems: FactProblem[] = [
      { claim: "а", issue: "и", severity: "block" },
      { claim: "б", issue: "и", severity: "warn" },
      { claim: "в", issue: "и", severity: "warn" },
    ];
    expect(verdictLine({ problems, opened: 3, at: "" })).toBe(
      "сверено по 3 источник(ам): блокирующих 1, замечаний 2",
    );
  });
});

describe("приписка автору на переписывание", () => {
  test("на пустом списке приписки нет", () => {
    expect(fixNote([])).toBe("");
  });

  test("блокирующие помечены, источник указан, смягчать запрещено", () => {
    const note = fixNote([
      { claim: "выкупили весь флоат", issue: "в релизе этого нет", severity: "block", source: "https://a.test" },
      { claim: "по данным Reuters", issue: "агентство об этом не писало", severity: "warn" },
    ]);
    expect(note).toContain("[блок] «выкупили весь флоат»");
    expect(note).toContain("(источник: https://a.test)");
    expect(note).not.toContain("[блок] «по данным Reuters»");
    expect(note).toContain("убери из текста целиком, а не смягчай формулировку");
  });
});

describe("сорвавшаяся проверка = блокирующая претензия", () => {
  const dead = (async () => {
    throw new Error("сеть недоступна");
  }) as unknown as typeof fetch;

  test("падение проверяющего не пропускает материал мимо проверки", async () => {
    // «Фактчекер упал» и «фактчекер промолчал» обязаны значить одно и то же:
    // публикация идёт без человека.
    const v = await factCheck(
      { title: "Т", items: [{ text: "и", url: "https://a.test" }] },
      {
        ask: async () => {
          throw new Error("max turns");
        },
        fetchImpl: dead,
      },
    );
    expect(passed(v)).toBe(false);
    expect(v.opened).toBe(0);
    expect(v.problems[0]!.issue).toContain("проверка фактов не состоялась");
  });

  test("ответ без JSON — тоже несостоявшаяся проверка, а не пропуск", async () => {
    const v = await factCheck(
      { title: "Т", items: [{ text: "и", url: "https://a.test" }] },
      { ask: async () => "Я всё проверил, претензий нет.", fetchImpl: dead },
    );
    expect(passed(v)).toBe(false);
    expect(v.problems[0]!.issue).toContain("нет JSON-объекта");
  });
});

describe("черновик дня: отказ автора — не материал", () => {
  test("заголовок-оговорка ловится", () => {
    // 25.09.2026: на месте новости Hotstuff на сайте стояла страница
    // «Материал не опубликован…». Владелец увидел не «новости нет», а
    // «новость есть, и она о том, что новости нет».
    for (const title of [
      "Материал не опубликован: источник не поддаётся проверке",
      "Новость не будет опубликована",
      "Редакция не может подтвердить данные",
      "Не удалось подтвердить остановку торгов",
      "Снято с публикации",
    ]) {
      expect(looksLikeRefusal({ title, body: "" })).toBe(true);
    }
  });

  test("оговорка в теле ловится только с начала", () => {
    expect(looksLikeRefusal({ title: "Фонд вышел", body: "Редакция не может опубликовать это." })).toBe(
      true,
    );
    // У честного материала такие обороты встречаются в середине — и это норма.
    expect(
      looksLikeRefusal({
        title: "Фонд вышел из позиции",
        body: "Независимое подтверждение отсутствует, но редакция не может игнорировать заявление.",
      }),
    ).toBe(false);
  });
});

describe("сверка черновика: что попадает в отчёт владельцу", () => {
  const art = (title: string): DraftArticle =>
    ({
      title,
      date: "2026-09-30",
      summary: "Лид",
      body: "Тело материала в двух абзацах.",
      items: [{ text: "источник", url: "https://a.test" }],
    }) as DraftArticle;

  const ok = { problems: [], opened: 2, at: "2026-09-30T08:00:00.000Z" };
  const bad = {
    problems: [{ claim: "цифра", issue: "в источнике её нет", severity: "block" as const }],
    opened: 2,
    at: "2026-09-30T08:00:00.000Z",
  };

  test("прошедшая статья получает отметку сверки", async () => {
    const r = await vetArticles([art("Фонд выкупил флоат")], {
      check: async () => ok,
      revise: async () => null,
    });
    expect(r.articles).toHaveLength(1);
    expect(r.articles[0]!.checked).toEqual({ at: ok.at, opened: 2 });
    expect(r.report).toEqual([]);
  });

  test("снятая статья видна в отчёте по имени", async () => {
    const r = await vetArticles([art("Фонд выкупил флоат")], {
      check: async () => bad,
      revise: async () => null,
    });
    expect(r.articles).toEqual([]);
    expect(r.report.join("\n")).toContain("снято целиком: «Фонд выкупил флоат»");
  });

  test("переписанная проходит вторую сверку и отмечается как переписанная", async () => {
    let call = 0;
    const r = await vetArticles([art("Фонд выкупил флоат")], {
      check: async () => (++call === 1 ? bad : ok),
      revise: async (a) => ({ ...a, body: "Переписано по источникам." }),
    });
    expect(r.articles).toHaveLength(1);
    expect(r.report.join("\n")).toContain("переписано по источникам");
  });

  test("вторая попытка не даётся: претензии остались — статья снимается", async () => {
    // Второй заход не найдёт подтверждения, он найдёт формулировку помягче.
    let calls = 0;
    const r = await vetArticles([art("Фонд выкупил флоат")], {
      check: async () => {
        calls++;
        return bad;
      },
      revise: async (a) => a,
    });
    expect(r.articles).toEqual([]);
    expect(calls).toBe(2);
    expect(r.report.join("\n")).toContain("после правки претензии остались");
  });

  test("отказ снимается до сверки — проверять в нём нечего", async () => {
    let checked = false;
    const r = await vetArticles([art("Материал не опубликован: нет подтверждения")], {
      check: async () => {
        checked = true;
        return ok;
      },
      revise: async () => null,
    });
    expect(checked).toBe(false);
    expect(r.articles).toEqual([]);
    expect(r.report.join("\n")).toContain("это отказ от публикации, а не новость");
  });

  test("отказ вместо переписанной статьи тоже снимается", async () => {
    const r = await vetArticles([art("Фонд выкупил флоат")], {
      check: async () => bad,
      revise: async () => art("Редакция не может опубликовать материал"),
    });
    expect(r.articles).toEqual([]);
    expect(r.report.join("\n")).toContain("автор вернул отказ от публикации");
  });

  test("замечания не снимают статью, но в отчёт попадают", async () => {
    const r = await vetArticles([art("Фонд выкупил флоат")], {
      check: async () => ({
        problems: [{ claim: "ссылка", issue: "источник отвечает 403", severity: "warn" as const }],
        opened: 2,
        at: ok.at,
      }),
      revise: async () => null,
    });
    expect(r.articles).toHaveLength(1);
    expect(r.report.join("\n")).toContain("источник отвечает 403");
  });
});

describe("отчёт сверки в полном тексте на апрув", () => {
  const a = { title: "Т", date: "2026-09-30", summary: "С", body: "Б", items: [] } as unknown as DraftArticle;

  test("отчёт стоит первым блоком — раньше того, что осталось", () => {
    const text = buildDraftReviewText([a], ["✂️ снято целиком: «Х»"]);
    expect(text.indexOf("Сверка с первоисточниками")).toBeLessThan(text.indexOf("1/1 · Т"));
  });

  test("пустой отчёт строки не добавляет", () => {
    expect(buildDraftReviewText([a])).not.toContain("Сверка с первоисточниками");
  });
});
