/**
 * Аудит 2026-09-23: неодобренный черновик не занимал тему.
 *
 * В «Избранном» юзербота нашёлся 71 черновик, который владелец так и не
 * апрувил, и в нём запуск GPT-6 Astra от 3 сентября лежал трижды — за 4, 5 и
 * 6-е, — а Remixpoint, Consensys, анлок HYPE и DeepSeek по два раза. Дедуп
 * спрашивал у сайта только ОПУБЛИКОВАННОЕ, а неодобренный черновик публикацией
 * не становится: назавтра тема выглядела свежей и предлагалась заново.
 *
 * Тест держит второй источник дедупа — журнал предложенного — вместе с его
 * сроком давности и терпимостью к битому файлу.
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isDuplicate,
  recentProposedTitles,
  recordProposedTitles,
  PROPOSED_MAX_AGE_MS,
} from "../tools/daily-draft.ts";

const ASTRA = "OpenAI выпустила GPT-6 Astra — модель, которая сама садится за ваш компьютер";
const ASTRA_NEXT_DAY = "OpenAI выпустил GPT-6 Astra и объявил начало эры AGI";

const withTmp = (fn: (path: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "proposed-"));
  try {
    fn(join(dir, "proposed-titles.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("журнал предложенных тем", () => {
  test("предложенное вчера закрывает тему сегодня", () => {
    withTmp((path) => {
      const day1 = Date.parse("2026-09-04T06:00:00.000Z");
      recordProposedTitles([ASTRA], path, day1);
      const day2 = day1 + 24 * 60 * 60 * 1000;
      expect(isDuplicate(ASTRA_NEXT_DAY, recentProposedTitles(path, day2))).toBe(true);
    });
  });

  test("тема освобождается, когда запись протухла", () => {
    withTmp((path) => {
      const t0 = Date.parse("2026-09-04T06:00:00.000Z");
      recordProposedTitles([ASTRA], path, t0);
      expect(recentProposedTitles(path, t0 + PROPOSED_MAX_AGE_MS + 1)).toEqual([]);
    });
  });

  test("протухшие строки выбрасываются при следующей записи", () => {
    withTmp((path) => {
      const t0 = Date.parse("2026-09-04T06:00:00.000Z");
      recordProposedTitles([ASTRA], path, t0);
      const later = t0 + PROPOSED_MAX_AGE_MS + 1;
      recordProposedTitles(["Solana ускорила слоты до 250 мс"], path, later);
      const rows = JSON.parse(readFileSync(path, "utf8"));
      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBe("Solana ускорила слоты до 250 мс");
    });
  });

  test("несколько прогонов копятся, а не затирают друг друга", () => {
    withTmp((path) => {
      const t0 = Date.parse("2026-09-04T06:00:00.000Z");
      recordProposedTitles(["Первая", "Вторая"], path, t0);
      recordProposedTitles(["Третья"], path, t0 + 60_000);
      expect(recentProposedTitles(path, t0 + 120_000).sort()).toEqual([
        "Вторая",
        "Первая",
        "Третья",
      ]);
    });
  });

  test("битый и отсутствующий файл не роняют прогон", () => {
    withTmp((path) => {
      expect(recentProposedTitles(path)).toEqual([]);
      writeFileSync(path, "{не json", "utf8");
      expect(recentProposedTitles(path)).toEqual([]);
      writeFileSync(path, JSON.stringify({ title: "не список" }), "utf8");
      expect(recentProposedTitles(path)).toEqual([]);
    });
  });

  test("строки без заголовка или с битой датой игнорируются", () => {
    withTmp((path) => {
      const at = "2026-09-04T06:00:00.000Z";
      writeFileSync(
        path,
        JSON.stringify([
          { at, title: "Живая" },
          { at, title: "   " },
          { at: "не дата", title: "Битая дата" },
          { title: "Без даты" },
          null,
        ]),
        "utf8",
      );
      expect(recentProposedTitles(path, Date.parse(at) + 1000)).toEqual(["Живая"]);
    });
  });

  test("пустой список тем файла не создаёт", () => {
    withTmp((path) => {
      recordProposedTitles([], path);
      expect(recentProposedTitles(path)).toEqual([]);
    });
  });
});
