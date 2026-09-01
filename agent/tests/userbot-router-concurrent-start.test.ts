/**
 * Аудит 2026-08-08: параллельные вызовы getAgentHandle поднимали две сессии.
 *
 * `startUserbot` — сетевое подключение к Telegram, секунды. Проверка
 * `sessions.has(agentKey)` в начале и `sessions.set(...)` в конце разнесены на
 * всё это время, а зовут getAgentHandle из dispatch'а, где действия одного
 * агента идут параллельно. Два вызова видели пустую карту и оба поднимали
 * клиента на ОДНОМ файле сессии; `sessions.set` оставлял победителя, а
 * проигравший продолжал жить со своим обработчиком апдейтов — каждое входящее
 * сообщение уезжало в onMessage дважды. Остановить его было нечем: ссылки не
 * осталось нигде.
 *
 * Стенд подменяет startSession — важна дедупликация в getAgentHandle, а не
 * работа gramjs.
 */
import { test, expect, describe } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UserbotRouter } from "../lib/userbot-router.ts";

function sessionFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "ubrouter-"));
  const f = join(dir, "agent.session");
  writeFileSync(f, "stub");
  return f;
}

/** Заглушка сессии: считает вызовы stop() и умеет отдавать сообщения. */
function fakeHandle(tag: string) {
  return {
    isNoop: false,
    tag,
    stops: 0,
    async stop() {
      (this as any).stops++;
    },
  } as any;
}

/**
 * Роутер с медленным стартом. Возвращает промис, который резолвится только
 * когда тест разрешит — так воспроизводится окно между проверкой и записью.
 */
function routerWithGatedStart() {
  const router = new UserbotRouter({
    onMessage: () => {},
    defaultAllowedChatIds: [-100],
  });
  router.registerAgent("smm", { sessionFile: sessionFile(), allowedChatIds: [-100] });

  let starts = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  (router as any).startSession = async (agentKey: string) => {
    starts++;
    const h = fakeHandle(`${agentKey}#${starts}`);
    await gate;
    (router as any).sessions.set(agentKey, h);
    return h;
  };
  return { router, gate, release: () => release(), starts: () => starts };
}

describe("UserbotRouter: один агент — одна сессия", () => {
  test("десять параллельных вызовов поднимают ровно одну сессию", async () => {
    const { router, release, starts } = routerWithGatedStart();

    const all = Promise.all(
      Array.from({ length: 10 }, () => router.getAgentHandle("smm")),
    );
    // Все десять уже внутри — старт ещё не завершён.
    expect(starts()).toBe(1);
    release();
    const handles = await all;

    expect(starts()).toBe(1);
    // Все получили ОДИН И ТОТ ЖЕ handle: два разных означали бы два живых
    // обработчика апдейтов и двойной ингест каждого сообщения.
    for (const h of handles) expect(h).toBe(handles[0]);
    expect(router.getActiveAgents()).toEqual(["smm"]);
  });

  test("после успешного старта повторный вызов не стартует заново", async () => {
    const { router, release, starts } = routerWithGatedStart();
    const first = router.getAgentHandle("smm");
    release();
    const a = await first;
    const b = await router.getAgentHandle("smm");
    expect(b).toBe(a);
    expect(starts()).toBe(1);
  });

  test("неудачный старт не залипает — следующий вызов пробует снова", async () => {
    // Иначе одна сетевая ошибка при первом обращении навсегда выключала бы
    // сессию агента до рестарта процесса.
    const router = new UserbotRouter({
      onMessage: () => {},
      defaultAllowedChatIds: [-100],
    });
    router.registerAgent("smm", { sessionFile: sessionFile(), allowedChatIds: [-100] });
    let calls = 0;
    (router as any).startSession = async (agentKey: string) => {
      calls++;
      if (calls === 1) return null;
      const h = fakeHandle(agentKey);
      (router as any).sessions.set(agentKey, h);
      return h;
    };

    expect(await router.getAgentHandle("smm")).toBeNull();
    expect(await router.getAgentHandle("smm")).not.toBeNull();
    expect(calls).toBe(2);
  });

  test("stopAll дожидается стартующей сессии и гасит её", async () => {
    // Сессия, доехавшая до sessions уже после очистки карты, осталась бы жить
    // с обработчиком апдейтов и без владельца.
    const { router, release } = routerWithGatedStart();
    const pending = router.getAgentHandle("smm");

    const stopping = router.stopAll();
    release();
    await stopping;

    const handle: any = await pending;
    expect(handle.stops).toBe(1);
    expect(router.getActiveAgents()).toEqual([]);
  });
});
