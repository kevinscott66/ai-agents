/**
 * Аудит 2026-08-20 — исходники репозитория обязаны быть текстом.
 *
 * `site/server/index.ts` содержал сырой NUL-байт (разделитель хэша записали
 * настоящим 0x00 вместо escape-последовательности). Семантика верна, `tsc
 * --noEmit` и `bun test` довольны — но `file` называл файл `data`, и любой
 * обычный `grep` молча пропускал его целиком:
 *
 *   $ grep -n "api/internal" site/server/index.ts      → пусто
 *   $ grep -n "SITE_INGEST_TOKEN" site/server/index.ts → пусто
 *
 * Пропускал единственный файл, где живут `tokenMatches`, `authedJsonBody` и
 * оба `/api/internal/*`. Значит, «чисто» возвращали и поиск секретов, и гейт на
 * маркеры конфликта из CLAUDE.md §3.8, и любой ручной аудит.
 * `scan-staged-secrets.sh` спасён случайно — флагом `-a` у grep, а не замыслом.
 *
 * Ничто в репозитории не утверждало, что исходники — текст. Теперь утверждает.
 */
import { describe, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");

function trackedSources(): string[] {
  return execFileSync(
    "git",
    ["ls-files", "-z", "*.ts", "*.tsx", "*.js", "*.json", "*.md", "*.sh"],
    { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
}

describe("исходники видны обычному grep", () => {
  test("ни один отслеживаемый исходник не содержит сырого NUL-байта", () => {
    const offenders: string[] = [];
    for (const rel of trackedSources()) {
      let buf: Buffer;
      try {
        buf = readFileSync(resolve(REPO, rel));
      } catch {
        continue; // удалён из рабочего дерева, но ещё в индексе
      }
      const i = buf.indexOf(0);
      if (i !== -1) offenders.push(`${rel} (смещение ${i})`);
    }
    // Сообщение важнее самой проверки: следующий, кто это увидит, должен
    // сразу знать, что чинить — escape-последовательность в исходнике,
    // а не `.gitattributes` (тот чинит git diff, но не обычный grep).
    expect(offenders).toEqual([]);
  });

  test("контрольный пример: grep находит ingest-эндпоинт в index.ts", () => {
    const src = readFileSync(resolve(REPO, "site/server/index.ts"), "utf8");
    expect(src).toContain("/api/internal/digests");
    expect(Buffer.from(src, "utf8").indexOf(0)).toBe(-1);
  });
});
