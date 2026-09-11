/**
 * «Мы сейчас внутри `bun test`» — признак, который нельзя подделать переменной
 * окружения.
 *
 * Аудит 2026-08-20: единственной защитой моста на боевой сайт был
 * `process.env.NODE_ENV !== "test"`. Настоящая экспортированная переменная бьёт
 * дефолт bun'а — проверено (bun 1.3.14):
 *
 *   bun test                        → NODE_ENV === "test"        (гейт держит)
 *   NODE_ENV=production bun test    → NODE_ENV === "production"  (гейт СНЯТ)
 *
 * Путь к этому в репозитории прямой: `.env.example` предписывает владельцу
 * ставить `NODE_ENV=production` на сервере, оба unit-файла
 * (`deploy/agent-team-blue.service`, `-green.service`) держат
 * `Environment=NODE_ENV=production`. Обычный ops-приём «взять боевое окружение
 * для ручного прогона» — `set -a; . /opt/agent-team/.env; set +a` — экспортирует
 * заодно и `NODE_ENV=production`, и `SITE_INGEST_URL`/`SITE_INGEST_TOKEN`. Это
 * ровно условия T-743 (восемь тестовых страниц, опубликованных на живом
 * delabs.space и неснимаемых обратно), целиком восстановленные.
 *
 * Поэтому признак берётся из места, куда переменной окружения не дотянуться:
 * `agent/bunfig.toml` регистрирует `[test] preload = ["./tests/_setup.ts"]`, и
 * этот preload выполняется ТОЛЬКО под тест-раннером — при любом NODE_ENV, до
 * любого тестового файла, один раз на процесс. Он и ставит флаг.
 *
 * NODE_ENV остаётся вторым признаком, а не заменяется: прогон из корня репо
 * (где bunfig.toml не подхватится) preload'а не увидит, но дефолтный
 * NODE_ENV=test у bun'а там будет.
 *
 * Аудит 2026-08-28: этих двух признаков не хватало ровно на их пересечении.
 * Из корня репо preload не срабатывает (первый признак снят), а экспортированный
 * NODE_ENV=production бьёт дефолт bun'а (снят второй) — и мост открыт под
 * `bun test` с боевыми SITE_INGEST_*. Обе половины этого сочетания описаны в
 * репозитории как обычная практика: CLAUDE.md §3.8.1 разбирает прогон из корня
 * как частую ошибку, а ops-приём `set -a; . /opt/agent-team/.env; set +a`
 * экспортирует NODE_ENV=production вместе с токеном ингеста. То есть T-743
 * восстанавливался целиком, несмотря на файл, который для этого и написан.
 *
 * Третий признак — `Bun.main`. Под тест-раннером это путь текущего тестового
 * файла (проверено: в прогоне каталога он меняется от файла к файлу), а в
 * бою — `orchestrator-*.ts`. Переменной окружения его не подделать, bunfig для
 * него не нужен, и на пересечении выше он единственный остаётся поднятым.
 */
let _isTestRun = false;

/** Вызывается из tests/_setup.ts. Больше ниоткуда. */
export function markTestRun(): void {
  _isTestRun = true;
}

/**
 * Дефолтный набор bun'а: `*.test.*`, `*_test.*`, `*.spec.*`, `*_spec.*`.
 * Держим его целиком, а не только `.test.ts` — иначе признак отвалится молча
 * от переименования файла.
 */
const TEST_FILE_RE = /[._](test|spec)\.[cm]?[jt]sx?$/;

/** Отдельно от Bun.main, чтобы это можно было проверить тестом. */
export function _looksLikeTestFile(path: unknown): boolean {
  return typeof path === "string" && TEST_FILE_RE.test(path);
}

function mainIsTestFile(): boolean {
  try {
    return _looksLikeTestFile(typeof Bun === "undefined" ? undefined : Bun.main);
  } catch {
    // Bun.main теоретически может бросить в чужом рантайме; тогда просто
    // остаёмся на двух прежних признаках.
    return false;
  }
}

export function isTestRun(): boolean {
  return _isTestRun || process.env.NODE_ENV === "test" || mainIsTestFile();
}
