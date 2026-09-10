/**
 * Bun + telegraf: обработчики верхнего уровня.
 *
 * Здесь остался ровно один сайд-эффект на импорт — `uncaughtException` и
 * `unhandledRejection`. Первый глушит шум сетевого клиента telegraf и ТОЛЬКО
 * его; любое другое необработанное исключение означает неизвестное состояние
 * процесса — логируем, пишем alert и выходим, systemd поднимет чистый (см.
 * комментарий у обработчика ниже).
 *
 * Аудит 2026-09-10: отсюда удалён monkey-patch `redactToken`, который занимал
 * половину файла и не выполнялся НИ РАЗУ. Две независимые причины, обе
 * проверяемые и закреплённые тестом
 * `tests/audit-2026-09-10-telegraf-patch-dead.test.ts`:
 *
 *  1. Патчить было нечего. `telegraf/lib/core/network/client.js` (4.16.3)
 *     объявляет `redactToken` как локальную функцию модуля и экспортирует
 *     только `exports.default = ApiClient`. `client.redactToken` — undefined,
 *     то есть условие `if (orig && …)` не выполнялось никогда, и патч молча
 *     не делал ничего. Судить о том, работает ли он, было не по чему: и успех
 *     (`[patch] telegraf redactToken wrapped`), и провал (`[patch] could not
 *     patch redactToken`) писали строку в лог, а «нашли модуль, но метода в нём
 *     нет» — самый вероятный исход — не писал ничего.
 *
 *  2. Патчить было не нужно. Посылка из старой шапки — «у Bun .message часто
 *     readonly» — на текущем Bun (1.3.14) не воспроизводится: у обычного
 *     `Error`, у `SyntaxError` из `JSON.parse` и у ошибки fetch дескриптор
 *     `message` — `writable: true, configurable: true`, присваивание проходит.
 *     Формулировка «часто» и отсутствие ссылки на версию говорят, что причину
 *     не локализовали, а обошли.
 *
 * Сеть под этим не оголяется: скрытие токена в тексте ошибки на боевом пути
 * делает `scrubSecretString` (lib/log.ts), через который проходят и `log.*`, и
 * синхронная запись в fd 2 ниже, — а не патч чужого модуля.
 */

import { log, scrubSecretString, scrubbedHead } from "./log.ts";

/** Кадры, по которым узнаётся стек сетевого клиента telegraf. */
const TELEGRAF_FRAMES = [
  "redactToken",
  "telegraf/lib/core/network/client",
  "node_modules/telegraf/",
];

/**
 * Шум сетевого клиента telegraf, ради которого этот обработчик и заведён.
 * Исторический повод — присваивание в `.message` внутри `redactToken`; сам
 * повод на текущем Bun не воспроизводится (см. шапку файла), но признак
 * остаётся верным для любого исключения, вылетевшего из клиента мимо его
 * собственных обработчиков. Такое исключение безвредно — состояние процесса от
 * него не портится, продолжать работу можно.
 *
 * Аудит 2026-08-28: текст сообщения был ТРЕТЬЕЙ равноправной альтернативой, а
 * не признаком в паре со стеком, — и `msg.includes("readonly property")`
 * глушил такую ошибку откуда угодно. Присваивание в замороженный объект не
 * привилегия telegraf (`Object.freeze` стоит и на `DISPATCH_ONLY_ACTIONS`),
 * даёт под Bun ровно этот текст, и прилетев мимо try/catch попадало в ветку
 * «безвредно»: одна warn-строка и работа дальше в неизвестном состоянии —
 * ровно то, что аудит 2026-08-20 закрывал на уровень выше.
 *
 * Ветка ничего не теряет: стек любой ошибки из сетевого клиента telegraf
 * содержит либо кадр `redactToken`, либо путь самого клиента — этого признака
 * достаточно, и он не зависит от текста.
 */
export function isTelegrafNoise(msg: string, stack: string): boolean {
  void msg;
  return TELEGRAF_FRAMES.some((frame) => stack.includes(frame));
}

/**
 * Аудит 2026-08-20: шапка этого файла обещает глушить uncaughtException
 * «если он пришёл изнутри telegraf-стека», а код глушил ВСЁ.
 *
 * Механика: сам факт наличия обработчика отменяет падение процесса. Проверено
 * на этом Bun — после `throw` из таймера процесс живёт дальше и выходит с 0.
 * То есть строка `log.error("UNCAUGHT", …)` была не «залогировали и упали», а
 * «залогировали и поехали дальше в неизвестном состоянии»: оборванная цепочка
 * промисов, недописанная транзакция, мёртвый polling-цикл одного из 12 ботов.
 * Снаружи это выглядит как «бот молчит», и молчит он до тех пор, пока кто-то
 * не заметит руками.
 *
 * Правильная реакция на неизвестное состояние — выйти и дать systemd поднять
 * чистый процесс: unit стоит `Restart=always`, `RestartSec=3`, так что простой
 * — три секунды. Петля рестартов тут маловероятна (StartLimitBurst=5 за 10s
 * при шаге 3s не выбирается), но если она всё же случится, у дежурного есть
 * аварийный тормоз без передеплоя: `UNCAUGHT_EXCEPTION_POLICY=keep`.
 */
function uncaughtPolicy(): "exit" | "keep" {
  return process.env.UNCAUGHT_EXCEPTION_POLICY === "keep" ? "keep" : "exit";
}

process.on("uncaughtException", (err: any) => {
  const msg = err?.message ?? String(err);
  const stack = err?.stack ?? "";
  if (isTelegrafNoise(msg, stack)) {
    // Скраб до обрезки, а не после: `log.warn` чистит `data`, но к тому
    // времени `slice` уже отрезал бы хвост токена, и правило перестало бы
    // совпадать. Форма ровно та: node-fetch кладёт в сообщение URL Bot API
    // вместе с токеном (см. `TELEGRAM_TOKEN` в lib/log.ts), а сюда попадают
    // как раз сетевые отказы.
    log.warn("[telegram] swallowed", { msg: scrubbedHead(msg, 200) });
    return;
  }

  const policy = uncaughtPolicy();
  log.error("UNCAUGHT", { error: msg, stack, policy });

  // Долгоживущий след, который переживёт рестарт: строка в audit_logs видна в
  // Mini App и в архиве. require, а не import — чтобы db.ts (а он на уровне
  // модуля создаёт базу и гоняет миграции) не попал в граф импорта тех, кто
  // грузит патч, и чтобы запись успела пройти ДО process.exit.
  try {
    // @ts-ignore — синхронный require .ts работает под Bun
    const { emitAlert } = require("./alerting.ts");
    emitAlert("critical", "uncaught_exception", "необработанное исключение", {
      error: msg.slice(0, 500),
      policy,
    });
  } catch (e) {
    log.error("UNCAUGHT: не удалось записать alert", {
      error: (e as any)?.message ?? String(e),
    });
  }

  if (policy === "keep") {
    log.warn(
      "UNCAUGHT: UNCAUGHT_EXCEPTION_POLICY=keep — процесс продолжает работу в неизвестном состоянии",
    );
    return;
  }

  // stdout под systemd — это пайп, и его буфер может не успеть слиться до
  // выхода. fd 2 пишется синхронно, поэтому последняя строка дойдёт всегда.
  //
  // Аудит 2026-08-28: строкой выше те же msg и stack уходят в log.error, а он
  // их чистит (lib/log.ts:212). Здесь чистки не было — то есть в одной функции
  // два стока одного текста, и второй, синхронный и попадающий прямиком в
  // journald, стоял открытым. Текст сюда приходит произвольный: node-fetch на
  // любой сетевой ошибке даёт `request to https://api.telegram.org/bot<ТОКЕН>/
  // sendMessage failed, reason: …` (форма, ради которой в скруббере заведён
  // TELEGRAM_TOKEN), а snapshotOf из mac-bridge.ts — `https://x-access-token:
  // ghp_…@github.com/…`. Ни та, ни другая под isTelegrafNoise не подходит:
  // стек указывает в node-fetch, не в telegraf. Инвариант lib/log.ts:13
  // («ALWAYS on — secrets must never log») на этом пути не исполнялся.
  try {
    // @ts-ignore
    require("node:fs").writeSync(
      2,
      scrubSecretString(`FATAL uncaughtException: ${msg}\n${stack}\n`),
    );
  } catch {
    // Некуда писать — выходим молча, структурный лог уже отправлен.
  }
  process.exit(1);
});

process.on("unhandledRejection", (reason: any) => {
  // Стек здесь не менее важен, чем текст: без него «[unhandledRejection]
  // undefined» в journalctl не приводит вообще никуда.
  log.warn("[unhandledRejection]", {
    reason: reason?.message ?? String(reason),
    stack: typeof reason?.stack === "string" ? reason.stack.slice(0, 1000) : undefined,
  });
});
