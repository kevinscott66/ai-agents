/**
 * Аудит 2026-08-13: растровая генерация утекала ролям через чужой payload.
 *
 * `ROLE_EXPOSED_TOOLS.GENERATE_IMAGE = ["design", "orchestrator"]` — растр
 * намеренно держат за двумя ролями. Но `PUBLISH_TO_CHANNEL` выдан ещё `smm` и
 * `copy`, а поле `coverPrompt` в его payload ведёт в `generateCoverPng` →
 * `generateImage`, то есть в тот же самый OpenAI. Ролевая проверка стояла на
 * имени действия, и второй маршрут её не проходил.
 *
 * Деньги и адресат к этому моменту уже закрыты (лимит GENERATE_IMAGE считается
 * тут же, публикация в ALWAYS_APPROVE_ACTIONS, канал сужен `isTeamChannel`),
 * поэтому находка низкая. Чинится там же, где считается бюджет.
 *
 * Аудит 2026-08-20 — ожидания ниже пересмотрены. Тот фикс уводил роль без
 * растра в SVG-фолбэк, а `ROLE_EXPOSED_TOOLS.GENERATE_SVG_IMAGE` — ТОТ ЖЕ
 * список `["design","orchestrator"]`. То есть гейт закрывал OpenAI и тут же
 * отдавал Claude: `smm`/`copy` получали ровно то, что фикс закрывал, только
 * нарисованное другим движком и бесплатно (return стоял ДО счётчика). Гейт был
 * декоративным. Теперь роль без обоих инструментов получает отказ, а превью
 * поста берётся из ЛОКАЛЬНОГО баннера в action-dispatch — рендер без LLM и без
 * ролевых инструментов, — так что публикация ничего не теряет.
 */
import { describe, test, expect, afterEach } from "bun:test";
import { generateCoverPng } from "../lib/dispatch/media.ts";
import { isToolExposedToRole } from "../lib/permissions.ts";
import { _resetRateLimits, checkRateLimit } from "../lib/rate-limits.ts";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>`;

afterEach(() => _resetRateLimits());

/** Счётчики вместо походов в OpenAI/Anthropic. */
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

describe("обложка публикации уважает ролевую выдачу GENERATE_IMAGE", () => {
  test("предпосылка: smm и copy публикуют, но растр им не выдан", () => {
    expect(isToolExposedToRole("PUBLISH_TO_CHANNEL", "smm")).toBe(true);
    expect(isToolExposedToRole("PUBLISH_TO_CHANNEL", "copy")).toBe(true);
    expect(isToolExposedToRole("GENERATE_IMAGE", "smm")).toBe(false);
    expect(isToolExposedToRole("GENERATE_IMAGE", "copy")).toBe(false);
    expect(isToolExposedToRole("GENERATE_IMAGE", "design")).toBe(true);
  });

  for (const role of ["smm", "copy"]) {
    test(`${role} не получает НИ платной, НИ дешёвой генерации`, async () => {
      const { calls, deps: d } = deps();
      await expect(generateCoverPng("промпт обложки", role, d)).rejects.toThrow(
        /GENERATE_SVG_IMAGE/,
      );

      expect(calls.paid).toBe(0);
      // Аудит 2026-08-20: раньше здесь стояло `toBe(1)` — фолбэк считался
      // «дешёвой картинкой», хотя это второй инструмент, роли не выданный.
      expect(calls.cheap).toBe(0);
    });

    test(`${role} не списывает слот из бюджета картинок`, async () => {
      const { deps: d } = deps();
      await generateCoverPng("промпт обложки", role, d).catch(() => {});

      // Отказ по роли — не расход: бакет GENERATE_IMAGE остаётся нетронутым.
      expect(checkRateLimit(role, "GENERATE_IMAGE").ok).toBe(true);
    });
  }

  test("design по-прежнему получает растр и платит слотом", async () => {
    const { calls, deps: d } = deps();
    const buf = await generateCoverPng("промпт обложки", "design", d);

    expect(buf.toString()).toBe("png");
    expect(calls.paid).toBe(1);
    expect(calls.cheap).toBe(0);
  });

  test("orchestrator тоже проходит — гейт не сузился до одной роли", async () => {
    const { calls, deps: d } = deps();
    await generateCoverPng("промпт обложки", "orchestrator", d);
    expect(calls.paid).toBe(1);
  });
});
