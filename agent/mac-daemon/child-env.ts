/**
 * Environment passed to the spawned Claude CLI.
 *
 * Keep this exact-name allowlist deliberately boring. Authentication belongs
 * to the Claude installation/keychain, not to an inherited process env where
 * prompt-driven output could disclose it over the bridge.
 */
const CHILD_ENV_ALLOW_EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
]);

/**
 * Путь до бинаря `claude` из env.
 *
 * `??` тут был неверным оператором: `.env.example` отгружает `CLAUDE_BIN=` с
 * комментарием «Пусто = ищется в PATH», и пустая строка проходит `??`
 * насквозь. `Bun.spawn({cmd: ["", …]})` бросает `Executable not found in
 * $PATH: ""`, то есть КАЖДЫЙ прогон отвечает `spawn_failed` при бодром
 * стартовом логе и живом сокете — а `MAC_RUN_CLAUDE` это единственный способ
 * команды из 12 ролей дотянуться до Mac. `CLAUDE_BIN= ` с хвостовым пробелом
 * даёт то же самое через ENOENT: `" "` истинно.
 *
 * Идиома `?.trim() ||` — та же, что у `_resolveBridgeHost` и `resolveDbPath`.
 * Сам путь не тримим: значимый пробел в пути возможен, отсекаем только
 * целиком пробельное значение.
 */
export function resolveClaudeBin(
  src: Record<string, string | undefined> = process.env,
): string {
  const raw = src.CLAUDE_BIN;
  return raw?.trim() ? raw : "claude";
}

/**
 * Отфильтрованное окружение дочернего `claude`.
 *
 * `cwd` — каталог, в котором прогон РЕАЛЬНО запускается (`Bun.spawn({cwd})`).
 *
 * Аудит 2026-09-11: `PWD` стояло в списке разрешённых и наследовалось от
 * демона как есть. Демон запускается через launchd из своего каталога, а
 * ребёнку задаётся `cwd: allowedProject` — то есть ребёнок получал `PWD`,
 * указывающий НЕ туда, где он работает, и, как правило, вообще за пределы
 * `MAC_PROJECT_ROOTS`. Всё, что внутри прогона читает `$PWD` вместо
 * `getcwd()` — а это любая шелл-строка, которую соберёт сама модель, — видело
 * чужой путь. Аллоулист каталогов и есть здесь граница безопасности, и
 * переменная, тихо называющая путь за ней, эту границу размывает.
 *
 * Поэтому `PWD` не наследуется, а ВЫВОДИТСЯ из `cwd`. Без `cwd` переменной
 * нет вовсе: пустое значение хуже отсутствующего — `getcwd()` даёт правду, а
 * `PWD=""` даёт молчаливую ложь.
 */
export function sanitizeChildEnv(
  src: Record<string, string | undefined>,
  cwd?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(src)) {
    if (value !== undefined && CHILD_ENV_ALLOW_EXACT.has(key)) {
      out[key] = value;
    }
  }
  if (cwd) out.PWD = cwd;
  return out;
}
