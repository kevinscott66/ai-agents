/**
 * Аудит 2026-08-20: недельный итог терялся на неделю целиком.
 *
 * Две сцепленные дыры в weekly-draft.
 *
 * 1. `main` брала окно как `weekBounds(сейчас)`. В штатное воскресенье это
 *    верно, но `Persistent=true` догоняет пропущенный запуск при старте VPS —
 *    и догон приходит уже в понедельник. Тогда окно = неделя, начавшаяся
 *    полдня назад: пунктов в ней нет, прогон выходит по ветке «публиковать
 *    нечего» с кодом 0, а закрытая неделя не подводится никогда — следующий
 *    запуск таймера через семь дней и уже про другую неделю.
 *
 * 2. Повтора не было вовсе: воскресный отказ («слот занят чужим черновиком»,
 *    «сайт недоступен») означал ту же потерю. Повтор в понедельник безопасен
 *    только вместе с меткой недели — иначе удачное воскресенье дало бы второй
 *    черновик про ту же неделю.
 *
 * Проверяем ровно это: какую неделю берём в разные дни и что метка ключуется
 * понедельником, а не датой запуска.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recapBounds,
  weekBounds,
  weeklyMarkerPath,
  weeklyAlreadyDrafted,
  markWeeklyDrafted,
} from "../tools/weekly-draft.ts";

// Воскресенье 2026-08-16, 18:00 UTC — штатный запуск таймера.
const SUNDAY_RUN = new Date("2026-08-16T18:00:00Z");
// Понедельник 2026-08-17, 18:00 UTC — повтор/догон.
const MONDAY_RUN = new Date("2026-08-17T18:00:00Z");
// Вторник — крайний догон после долгого простоя.
const TUESDAY_RUN = new Date("2026-08-18T18:00:00Z");

describe("какую неделю подводим", () => {
  test("воскресный запуск берёт неделю, которая заканчивается", () => {
    const r = recapBounds(SUNDAY_RUN);
    // Та же неделя, что и у прежней weekBounds — штатный путь не изменился.
    const w = weekBounds(SUNDAY_RUN);
    expect(r.from.getTime()).toBe(w.from.getTime());
    expect(r.to.getTime()).toBe(w.to.getTime());
    // Воскресный прогон лежит ВНУТРИ окна.
    expect(SUNDAY_RUN.getTime()).toBeGreaterThan(r.from.getTime());
    expect(SUNDAY_RUN.getTime()).toBeLessThan(r.to.getTime());
  });

  test("понедельничный запуск подводит ПРОШЕДШУЮ неделю, а не начавшуюся", () => {
    const sun = recapBounds(SUNDAY_RUN);
    const mon = recapBounds(MONDAY_RUN);
    expect(mon.from.getTime()).toBe(sun.from.getTime());
    expect(mon.to.getTime()).toBe(sun.to.getTime());
    // Именно здесь старый код брал не ту неделю.
    expect(weekBounds(MONDAY_RUN).from.getTime()).toBe(sun.to.getTime());
  });

  test("догон во вторник всё ещё подводит ту же неделю", () => {
    expect(recapBounds(TUESDAY_RUN).from.getTime()).toBe(
      recapBounds(SUNDAY_RUN).from.getTime(),
    );
  });

  test("окно ровно семь суток и стыкуется без нахлёста", () => {
    const r = recapBounds(SUNDAY_RUN);
    expect(r.to.getTime() - r.from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    // Следующее воскресенье начинает окно ровно там, где кончилось это.
    const next = recapBounds(new Date(SUNDAY_RUN.getTime() + 7 * 86_400_000));
    expect(next.from.getTime()).toBe(r.to.getTime());
  });

  test("понедельник и воскресенье дают ОДИН ключ недели", () => {
    expect(recapBounds(MONDAY_RUN).monday.toISOString().slice(0, 10)).toBe(
      recapBounds(SUNDAY_RUN).monday.toISOString().slice(0, 10),
    );
  });

  test("ключ недели — понедельник, а не дата запуска", () => {
    const { monday } = recapBounds(SUNDAY_RUN);
    expect(monday.toISOString().slice(0, 10)).toBe("2026-08-10");
    expect(monday.getUTCDay()).toBe(1);
  });
});

describe("метка недели", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "weekly-marker-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("до прогона метки нет, после — есть", () => {
    const { monday } = recapBounds(SUNDAY_RUN);
    expect(weeklyAlreadyDrafted(monday, dir)).toBe(false);
    markWeeklyDrafted(monday, dir);
    expect(weeklyAlreadyDrafted(monday, dir)).toBe(true);
  });

  test("метка воскресенья гасит понедельничный повтор", () => {
    markWeeklyDrafted(recapBounds(SUNDAY_RUN).monday, dir);
    expect(weeklyAlreadyDrafted(recapBounds(MONDAY_RUN).monday, dir)).toBe(true);
  });

  test("метка прошлой недели не гасит следующую", () => {
    markWeeklyDrafted(recapBounds(SUNDAY_RUN).monday, dir);
    const nextSunday = new Date(SUNDAY_RUN.getTime() + 7 * 86_400_000);
    expect(weeklyAlreadyDrafted(recapBounds(nextSunday).monday, dir)).toBe(false);
  });

  test("имя файла содержит дату понедельника", () => {
    const { monday } = recapBounds(SUNDAY_RUN);
    expect(weeklyMarkerPath(monday, dir)).toBe(join(dir, "weekly-2026-08-10.done"));
  });

  test("старые метки подметаются, свежие остаются", () => {
    // Метка годовой давности и метка прошлой недели.
    writeFileSync(join(dir, "weekly-2025-08-11.done"), "old", "utf8");
    const recent = new Date(Date.now() - 14 * 86_400_000);
    const recentName = `weekly-${recapBounds(recent).monday.toISOString().slice(0, 10)}.done`;
    writeFileSync(join(dir, recentName), "recent", "utf8");

    markWeeklyDrafted(recapBounds(new Date()).monday, dir);

    const left = readdirSync(dir);
    expect(left).not.toContain("weekly-2025-08-11.done");
    expect(left).toContain(recentName);
  });

  test("чужие файлы в каталоге уборка не трогает", () => {
    writeFileSync(join(dir, "pending.json"), "{}", "utf8");
    writeFileSync(join(dir, "weekly-notes.md"), "x", "utf8");
    markWeeklyDrafted(recapBounds(SUNDAY_RUN).monday, dir);
    const left = readdirSync(dir);
    expect(left).toContain("pending.json");
    expect(left).toContain("weekly-notes.md");
  });
});
