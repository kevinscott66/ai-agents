/**
 * T-751: зелёный прогон был зелёным только в одном порядке.
 *
 * `bun test` идёт по файлам в порядке обхода каталога, и этот порядок случайно
 * оказался безопасным. `bun test --randomize --seed=20260813` на том же коде
 * давал **9 падений**: тесты пишут в одну и ту же БД (`tests/_db-path.ts`
 * пинит MEMORY_DB_PATH на процесс, а не на файл), и файл, оставивший после
 * себя переписанную строку `permissions` или глобальный autonomy, ломал
 * следующего — c3 («12 ролей × 6 действий по сиду»), c6a (сид миграции 007),
 * c28-delegation (SPLIT_TASK в manual уходит в approval, детей ноль).
 *
 * Чинить только сами падения мало: следующий тест на ручку прав заведёт ту же
 * утечку заново, и обнаружится она снова случайным порядком через месяц.
 * Поэтому здесь — проба по исходникам: файл, который ПИШЕТ разделяемое
 * состояние, обязан рядом же называть, чем он его возвращает.
 *
 * Проба намеренно грубая (ищет имя восстановителя в тексте файла, а не
 * доказывает парность вызовов): цена ошибки первого рода — одна строка
 * `savePermissions` в новом тесте, цена пропуска — красный CI в неизвестный
 * день у неизвестного человека.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;

const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".test.ts"))
  .sort();

function read(f: string): string {
  return readFileSync(join(DIR, f), "utf8");
}

/** Восстановители прав, принятые в репо. */
const PERM_RESTORE = [
  "savePermissions(", // tests/_helpers.ts — общий снимок
  "restorePerm(", // t701/t702/t703 — локальный
  "restorePerms(", // t706 — снимок всей таблицы
  "snapshotPerm(",
  "snapshot(", // c6b — restores.push(snapshot(...))
  "DELETE FROM permissions", // тест сам сносит строку, которую завёл
];

/** Восстановители глобального autonomy. */
const GLOBAL_RESTORE = ["restoreAutonomy(", 'setAutonomy("global", "*", saved'];

describe("изоляция состояния между тестовыми файлами (T-751)", () => {
  test("файлов с тестами больше сотни — проба смотрит на весь каталог", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  test("кто пишет permissions — тот и возвращает", () => {
    const offenders = FILES.filter((f) => {
      const src = read(f);
      if (!src.includes("setPermission(")) return false;
      return !PERM_RESTORE.some((r) => src.includes(r));
    });
    expect(offenders).toEqual([]);
  });

  test("кто переводит ГЛОБАЛЬНЫЙ autonomy — тот и возвращает", () => {
    const offenders = FILES.filter((f) => {
      const src = read(f);
      if (!src.includes('setAutonomy("global"')) return false;
      return !GLOBAL_RESTORE.some((r) => src.includes(r));
    });
    expect(offenders).toEqual([]);
  });

  test("три файла-протечки из T-751 действительно снимают снимок", () => {
    // Не «где-то в каталоге», а поимённо: если правку когда-нибудь откатят,
    // общее правило выше могло бы остаться зелёным за счёт другого совпадения.
    expect(read("miniapp-agent-key-validation.test.ts")).toContain(
      'savePermissions([["backend", "SEND_MESSAGE"]])',
    );
    expect(read("c13-api.test.ts")).toContain('["qa", "SET_REACTION"]');
    expect(read("c33-dashboard.test.ts")).toContain(
      'setAutonomy("global", "*", savedGlobal)',
    );
  });

  test("счётчики общих уборщиков не сравниваются с константой", () => {
    // Второй класс той же болезни. `expireStaleApprovals`, `gcMessages`,
    // `exportColdStorage` работают по ВСЕЙ таблице — ни chat_id, ни автора они
    // не различают, и это правильно: ретеншен общий. Но тогда `expect(
    // res.deleted).toBe(1)` — утверждение про весь прогон: соседний файл,
    // оставивший одну старую строку, делает его двойкой. Такие проверки должны
    // вычитать чужое (`foreign`) или задавать пустоту порогом, а не надеждой на
    // пустую таблицу.
    const SWEEPERS = ["expireStaleApprovals(", "gcMessages(", "exportColdStorage("];
    const NETTING = ["foreign", "- foreign", "coldDays: 100_000"];
    const offenders = FILES.filter((f) => {
      const src = read(f);
      if (!SWEEPERS.some((s) => src.includes(s))) return false;
      // Точное сравнение результата уборщика с числом — вот форма, которая
      // ломается. `toBeGreaterThanOrEqual` и т.п. переживают чужие строки.
      const exact = /\.(deleted|expired|archived|pruned|exported)\)\s*\.toBe\(\s*\d/.test(
        src,
      );
      if (!exact) return false;
      return !NETTING.some((n) => src.includes(n));
    });
    expect(offenders).toEqual([]);
  });

  test("проверки MAC-действий сужены до своего чата", () => {
    // Список /api/actions глобальный: без chat_id тест видел строки соседних
    // файлов и «третьей сверху» оказывалась чужая.
    const src = read("c36-mac.test.ts");
    const unscoped = src.match(
      /api\/actions\?type=MAC_RUN_CLAUDE(?!&chat_id)/g,
    );
    // Единственный допустимый — проверка 401: до выборки дело не доходит.
    expect(unscoped?.length ?? 0).toBe(1);
  });
});
