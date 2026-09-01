/**
 * Аудит 2026-08-20: сгенерированный индекс вики никогда не доходил до промпта.
 *
 * `wikiIndex` (lib/memory.ts) отдаёт содержимое `index.md`, если файл есть и
 * непустой, и только иначе зовёт `buildWikiIndex`. Шапка `buildWikiIndex`
 * утверждала: «у index.md три читателя и НОЛЬ писателей, файла просто нет».
 * Файл был — 13 штук, закоммиченных в репозиторий:
 *
 *   agent/memory/_team/index.md            «Пока пусто. Заполняется агентами…»
 *   agent/memory/<role>/index.md ×12       «## Pages\n(пусто)»
 *
 * То есть `buildWikiIndex` не выполнялся ни для одной области. Читатели —
 * orchestrator/message-handler.ts (каждое сообщение всех 12 ролей),
 * lib/handoff.ts (каждое делегирование), lib/compactor.ts (каждый прогон
 * памяти). Правило компактора «если индекс уже содержит нужный slug — делай
 * update, а не create» физически не могло сработать: он сверялся с текстом
 * «(пусто)» и заводил новую страницу на ту же тему заново.
 *
 * Приоритет ручного index.md — осознанное решение и остаётся; ломала его
 * именно закоммиченная пустышка. Тест держит инвариант «в репозитории нет
 * index.md» и проверяет, что без файла индекс собирается из страниц.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Каталог вики в РЕПОЗИТОРИИ (не тот временный, что пинит _db-path.ts). */
const REPO_MEMORY = resolve(process.cwd(), "memory");

describe("index.md не лежит в репозитории", () => {
  test("ни в одной области нет закоммиченного index.md", () => {
    if (!existsSync(REPO_MEMORY)) return; // каталога может не быть — это норма
    const offenders: string[] = [];
    for (const scope of readdirSync(REPO_MEMORY, { withFileTypes: true })) {
      if (!scope.isDirectory()) continue;
      if (existsSync(join(REPO_MEMORY, scope.name, "index.md"))) {
        offenders.push(`memory/${scope.name}/index.md`);
      }
    }
    // Такой файл затеняет buildWikiIndex для своей области целиком и молча:
    // в промпте роли вместо списка страниц окажется его текст.
    expect(offenders).toEqual([]);
  });
});

// Поведенческую половину (без index.md индекс собирается из страниц) здесь
// НЕ держим намеренно: она требует wikiWrite, а до PR «tests: прогон гейта
// больше не правит живое дерево вики» MEMORY_DIR в тестах не пинится — и такая
// запись создала бы страницу в реальном agent/memory, то есть ровно тот мусор,
// от которого этот файл и защищает. Доказательство эффекта снято мутационным
// прогоном: с возвращёнными заглушками wikiIndex("_team") отдаёт текст
// заглушки вместо списка страниц (см. описание PR).
