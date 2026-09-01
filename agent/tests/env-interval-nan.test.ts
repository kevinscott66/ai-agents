/**
 * Аудит 2026-08-08: опечатка в env превращала интервал в 1 мс.
 *
 * Интервалы фоновых служб читались как
 * `process.env.X ? Number(process.env.X) : undefined`. Number("30s") — NaN, а
 * setInterval трактует NaN как 1 мс: на рантайме проекта это ~770 тиков в
 * секунду. Для watchdog — процесс, загруженный на ровном месте; для
 * health-монитора — getMe в Telegram по каждому из 12 ботов с той же частотой,
 * то есть 429 и блокировка всей команды. Bun печатает TimeoutNaNWarning, но
 * одну строку в stderr при таком потоке логов никто не увидит.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { _envPositiveInt } from "../orchestrator/services.ts";

const VAR = "TEST_ENV_INTERVAL_PROBE";
const prev = process.env[VAR];

afterEach(() => {
  // Без восстановления env течёт в соседние тесты (CLAUDE.md §3.8 п.7).
  if (prev === undefined) delete process.env[VAR];
  else process.env[VAR] = prev;
});

describe("_envPositiveInt", () => {
  test("нечисловое значение не доезжает до setInterval", () => {
    for (const bad of ["30s", "abc", "5 минут", "1e", "тридцать"]) {
      process.env[VAR] = bad;
      expect(_envPositiveInt(VAR, 30_000)).toBe(30_000);
    }
  });

  test("ноль и отрицательное — тоже дефолт", () => {
    // "0" — правдоподобный ввод в смысле «выключить», а на деле тот же 1 мс.
    for (const bad of ["0", "-1", "-30000"]) {
      process.env[VAR] = bad;
      expect(_envPositiveInt(VAR, 30_000)).toBe(30_000);
    }
  });

  test("дробное — дефолт: интервал в миллисекундах целый по смыслу", () => {
    process.env[VAR] = "1500.5";
    expect(_envPositiveInt(VAR, 30_000)).toBe(30_000);
  });

  test("корректное значение проходит как есть", () => {
    process.env[VAR] = "45000";
    expect(_envPositiveInt(VAR, 30_000)).toBe(45_000);
  });

  test("не задано или пусто — дефолт вызывающего", () => {
    delete process.env[VAR];
    expect(_envPositiveInt(VAR, 30_000)).toBe(30_000);
    process.env[VAR] = "";
    expect(_envPositiveInt(VAR, 30_000)).toBe(30_000);
  });

  test("без дефолта возвращается undefined — у шедулера свой", () => {
    // Подменять здесь дефолт шедулера значило бы держать вторую его копию.
    delete process.env[VAR];
    expect(_envPositiveInt(VAR)).toBeUndefined();
    process.env[VAR] = "мусор";
    expect(_envPositiveInt(VAR)).toBeUndefined();
  });
});

describe("почему это важно", () => {
  test("setInterval действительно трактует NaN как ~1 мс", async () => {
    // Тест-документация: без него «NaN → 1 мс» выглядит домыслом.
    //
    // Рядом крутится контрольный интервал на 10 с. Он и держит утверждение:
    // важно не «сколько успеет», а что NaN — это КРОШЕЧНЫЙ интервал, а не
    // большой и не «не запускать вовсе». Прежняя форма (>10 срабатываний за
    // 50 мс) мерила загруженность машины: в полном прогоне на 392 файла
    // event-loop успевает меньше, и тест краснел через раз — при том, что
    // поведение setInterval от нагрузки не зависит.
    let nanTicks = 0;
    let slowTicks = 0;
    const nan = setInterval(() => nanTicks++, NaN as unknown as number);
    const slow = setInterval(() => slowTicks++, 10_000);
    await new Promise((r) => setTimeout(r, 100));
    clearInterval(nan);
    clearInterval(slow);
    expect(nanTicks).toBeGreaterThan(2);
    expect(slowTicks).toBe(0);
  });
});
