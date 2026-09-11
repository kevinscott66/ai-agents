/**
 * Аудит 2026-08-28: «Остановить» внутри карточки сессии останавливало всё.
 *
 * Кнопка рисовалась в карточке конкретной сессии, называлась «Остановить» и
 * звала `api.macStop()` — без аргументов. На той стороне `stopMac`
 * (lib/mac-bridge.ts:373) шлёт демону один сигнал `stop`, документированный
 * как «kill all running processes», и следом роняет все ожидающие операции
 * (`failAllPending("mac_stopped")`). `sessionId` уходил только в подпись
 * спиннера «Остановка…».
 *
 * Единственным предупреждением был `title="Остановить все активные процессы"`,
 * то есть тултип — в мобильном WebView Telegram его не показывают вовсе, а
 * `window.confirm` рядом не стоял (Approvals, Agents и Tasks спрашивают).
 *
 * Второе: страница ни разу не читала `admin`, хотя ручка закрыта
 * `requireAdmin` (lib/miniapp-server.ts). Не-админ видел красную кнопку,
 * которая гарантированно вернёт 403.
 *
 * Третье: отказ уезжал в `setError`, а он на этой странице — ранний возврат
 * `if (error) return <ErrorBox …>`. Неудачная остановка (403, или 503
 * `mac_offline`, :970) стирала весь список сессий вместе с их выводом.
 * Остальные страницы Mini App пишут такие отказы в `toast()`.
 *
 * Проводка проверяется чтением исходника: DOM-харнесса у Mini App нет.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { stopAllConfirmText } from "../miniapp/src/lib/mac-session.ts";

const RAW = readFileSync(new URL("../miniapp/src/pages/Mac.tsx", import.meta.url), "utf8");
// Комментарии цитируют старый код — проверяем исполняемый текст.
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("stopAllConfirmText", () => {
  test("говорит, что остановятся ВСЕ процессы", () => {
    expect(stopAllConfirmText(1)).toContain("ВСЕ");
    expect(stopAllConfirmText(3)).toContain("ВСЕ");
  });

  test("при нескольких активных сессиях называет их число", () => {
    expect(stopAllConfirmText(3)).toContain("3");
  });

  test("при одной активной лишнего не досказывает", () => {
    expect(stopAllConfirmText(1)).not.toContain("Сейчас активных");
  });
});

describe("кнопка называет то, что делает", () => {
  test("подпись больше не про одну сессию", () => {
    expect(SRC).toContain("Остановить всё");
    expect(SRC).not.toMatch(/>\s*Остановить\s*</);
  });

  test("перед остановкой спрашивают", () => {
    expect(SRC).toContain("window.confirm(stopAllConfirmText(");
  });
});

describe("кнопка закрыта тем же гейтом, что и ручка", () => {
  test("признак берётся с сервера, а не угадывается", () => {
    expect(SRC).toMatch(/api\s*\.\s*autonomy\(\)/);
    expect(SRC).toContain("adminFromAutonomy(");
  });

  test("не-админу кнопку не рисуют", () => {
    expect(SRC).toContain("canStop &&");
  });
});

describe("отказ остановки не стирает страницу", () => {
  test("ошибка остановки уходит в тост, а не в ErrorBox", () => {
    const fn = SRC.slice(
      SRC.indexOf("async function handleStopAll"),
      SRC.indexOf("function selectProps"),
    );
    expect(fn.length).toBeGreaterThan(0);
    expect(fn).toContain("toast(");
    expect(fn).not.toContain("setError(");
  });

  test("состояние ошибки занимает список, а не всю страницу", () => {
    // Аудит 2026-08-28 оставил здесь ранний возврат `if (error) return
    // <ErrorBox`, считая его «про загрузку списка». Предпосылка была неверна:
    // возврат стоял выше блока с кнопкой стопа и уносил её с экрана вместе со
    // списком — то есть отказ ЧТЕНИЯ /api/actions отбирал право на ЗАПИСЬ в
    // /api/mac/stop, хотя ручки не связаны. Ровно тот же класс, что и тост в
    // тесте выше, только этажом выше по разметке (аудит 2026-08-29).
    expect(SRC).not.toContain("if (error) return <ErrorBox");
    expect(SRC).not.toContain("if (loading) return");
    expect(SRC.indexOf("<ErrorBox")).toBeGreaterThan(SRC.indexOf("canStop &&"));
  });
});

describe("предпосылки", () => {
  test("остановка на сервере действительно глобальная и админская", () => {
    const bridge = readFileSync(new URL("../lib/mac-bridge.ts", import.meta.url), "utf8");
    expect(bridge).toContain("kill all running processes");
    expect(bridge).toContain('failAllPending("mac_stopped")');

    const server = readFileSync(new URL("../lib/miniapp-server.ts", import.meta.url), "utf8");
    const route = server.slice(server.indexOf('path === "/api/mac/stop"'));
    expect(route.slice(0, 200)).toContain("requireAdmin(user)");
  });

  test("api.macStop по-прежнему без аргументов — сузить нечего", () => {
    // Демон умеет только «стоп всё»: точечной отмены нет ни в протоколе, ни в
    // ручке. Значит честность подписи — это всё, что здесь можно дать.
    const apiSrc = readFileSync(new URL("../miniapp/src/lib/api.ts", import.meta.url), "utf8");
    expect(apiSrc).toContain("macStop: () =>");
  });
});
