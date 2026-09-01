/**
 * Bun + telegraf совместимость.
 *
 * `redactToken` в telegraf делает `error.message = ...`, а у Bun .message часто
 * readonly — это валит процесс на любой сетевой ошибке. Здесь мы:
 *  1) Патчим redactToken: оборачиваем присваивание в try/catch + defineProperty.
 *  2) Глушим uncaughtException, если он пришёл изнутри telegraf-стека, —
 *     и ТОЛЬКО его. Любое другое необработанное исключение означает
 *     неизвестное состояние процесса: логируем, пишем alert и выходим,
 *     systemd поднимет чистый (см. комментарий у обработчика ниже).
 *
 * Сайд-эффект на импорт. Если уже пропатчено — повторно не патчим.
 */

import { log, scrubSecretString } from "./log.ts";

try {
  // @ts-ignore — грузим напрямую по абсолютному пути в node_modules
  const path = require("node:path");
  const clientAbs = path.join(
    process.cwd(),
    "node_modules/telegraf/lib/core/network/client.js",
  );
  const client = require(clientAbs);
  const orig = client.redactToken;
  if (orig && !(orig as any).__patched) {
    const safe = function safeRedactToken(error: any) {
      try {
        if (error && typeof error.message === "string") {
          const newMsg = error.message.replace(
            /\/(bot|user)(\d+):[^/]+\//,
            "/$1$2:[REDACTED]/",
          );
          try {
            error.message = newMsg;
          } catch (e1) {
            console.debug(
              "[patch] error.message assignment failed, falling back to defineProperty:",
              (e1 as any)?.message ?? String(e1),
            );
            try {
              Object.defineProperty(error, "message", {
                value: newMsg,
                configurable: true,
                writable: true,
              });
            } catch (e2) {
              console.debug(
                "[patch] defineProperty for error.message also failed (non-fatal):",
                (e2 as any)?.message ?? String(e2),
              );
            }
          }
        }
      } catch (e) {
        console.debug(
          "[patch] safeRedactToken outer guard caught (non-fatal):",
          (e as any)?.message ?? String(e),
        );
      }
      throw error;
    };
    (safe as any).__patched = true;
    client.redactToken = safe;
    log.info("[patch] telegraf redactToken wrapped");
  }
} catch (e) {
  log.warn("[patch] could not patch redactToken", { error: (e as any)?.message });
}

/** Кадры, по которым узнаётся стек сетевого клиента telegraf. */
const TELEGRAF_FRAMES = [
  "redactToken",
  "telegraf/lib/core/network/client",
  "node_modules/telegraf/",
];

/**
 * Шум telegraf/Bun, ради которого этот обработчик и заведён: присваивание в
 * readonly `.message` внутри redactToken. Он безвреден — состояние процесса
 * от него не портится, продолжать работу можно.
 *
 * Аудит 2026-08-28: текст сообщения был ТРЕТЬЕЙ равноправной альтернативой, а
 * не признаком в паре со стеком, — и `msg.includes("readonly property")`
 * глушил такую ошибку откуда угодно. Присваивание в замороженный объект не
 * привилегия telegraf (`Object.freeze` стоит и на `DISPATCH_ONLY_ACTIONS`),
 * даёт под Bun ровно этот текст, и прилетев мимо try/catch попадало в ветку
 * «безвредно»: одна warn-строка и работа дальше в неизвестном состоянии —
 * ровно то, что аудит 2026-08-20 закрывал на уровень выше.
 *
 * Ветка ничего не теряет: свой redactToken мы уже обернули в try/catch, так
 * что readonly может бросить только неперехваченный telegraf'овский — а его
 * стек содержит и `redactToken`, и путь клиента.
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
    log.warn("[telegram] swallowed", { msg: msg.slice(0, 200) });
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
