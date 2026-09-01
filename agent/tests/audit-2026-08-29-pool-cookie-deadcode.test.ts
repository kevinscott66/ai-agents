/**
 * Аудит 2026-08-29: три находки на путях, где поломка ТИХАЯ.
 *
 * 1. `cover-banner.ts` собирал путь к файлу фона через `new URL(f, dir)`, где
 *    `f` — сырое имя из `readdirSync`. Конструктор URL читает имя как ссылку:
 *    решётка режет остаток в фрагмент, знак вопроса — в query, проценты
 *    раскодируются (`fileURLToPath` снимает их обратно). Фильтр по расширению
 *    отрабатывает ДО этого, по сырому имени, поэтому в пул попадал путь к
 *    несуществующему файлу, `imgDataUri` молча возвращал null, а пост получал
 *    чистый баннер вместо иллюстрированного. Ни лога, ни ошибки; `hasBannerPool`
 *    при этом продолжал отвечать true. Сегодня в пуле `bg-01..04.jpg`, так что
 *    находка не стреляет — но стрельнёт от первого же файла, положенного туда
 *    человеком с обычным именем вроде `hero#2.jpg`.
 *
 * 2. `MiniAppSessionStore.tokenFromRequest` объявлен как `string | null`, но на
 *    `имя=` (пустое значение) отдавал пустую строку: `"имя=".split("=")` даёт
 *    `["имя", ""]`, и `value.length > 0` истинно. Дыры тут нет — `validate`
 *    начинается с `if (!token) return false`, — но контракт врал, и следующий
 *    вызывающий, проверяющий `!== null`, получил бы пустую строку за токен.
 *
 * 3. `telegram-chunking.ts` держал мёртвую `hardSlice`. Её единственный
 *    вызывающий переехал на инкрементальный цикл 2026-08-28 именно потому, что
 *    жадная резка меряла все куски, кроме первого, с чужой чётностью фенсов.
 *    Функция осталась лежать с сигнатурой, приглашающей «просто нарезать
 *    строку», и с предупреждением о фенсах внутри собственного докблока —
 *    ловушка для следующего.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MiniAppSessionStore } from "../lib/miniapp-session.ts";
import { splitForTelegram } from "../lib/telegram-chunking.ts";

/** Снимаем комментарии построчно: блочный regexp по всему файлу съедает код. */
function stripComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split("\n")) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) {
        out.push("");
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    for (;;) {
      const start = line.indexOf("/*");
      if (start === -1) break;
      const end = line.indexOf("*/", start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlock = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    const lineComment = line.indexOf("//");
    if (lineComment !== -1) line = line.slice(0, lineComment);
    out.push(line);
  }
  return out.join("\n");
}

const FP = MiniAppSessionStore.fingerprint("query_id=x&hash=xx");
const NAME = MiniAppSessionStore.cookieName(FP);

function reqWithCookie(cookie: string): Request {
  return new Request("https://miniapp.test/api/tasks", {
    method: "POST",
    headers: { cookie },
  });
}

describe("пул фонов баннера: имя файла — не ссылка", () => {
  const DIR = new URL("file:///pool/");

  // Замер того, ПОЧЕМУ старая форма ломалась. Не тавтология: обе конструкции
  // тут настоящие, и тест фиксирует, что они расходятся именно на этих именах.
  test.each([
    ["hero#2.jpg", "/pool/hero"],
    ["q?a.jpg", "/pool/q"],
    ["a%41.jpg", "/pool/aA.jpg"],
  ])("new URL мангает %j", (name, mangled) => {
    expect(fileURLToPath(new URL(name, DIR))).toBe(mangled);
    expect(join(fileURLToPath(DIR), name)).toBe(`/pool/${name}`);
  });

  test("обычное имя обе формы дают одинаково", () => {
    expect(fileURLToPath(new URL("bg-01.jpg", DIR))).toBe("/pool/bg-01.jpg");
    expect(join(fileURLToPath(DIR), "bg-01.jpg")).toBe("/pool/bg-01.jpg");
  });

  test("пул собирается join, а не резолвом URL", () => {
    const src = stripComments(
      readFileSync(join(import.meta.dir, "..", "lib", "cover-banner.ts"), "utf8"),
    );
    const pool = src.indexOf("function bannerPool()");
    expect(pool).toBeGreaterThan(-1);
    const end = src.indexOf("\n}", pool);
    expect(end).toBeGreaterThan(pool);
    const body = src.slice(pool, end);
    expect(body).toContain("join(dirPath, f)");
    // Именно резолв ИМЕНИ запрещён; `new URL("../assets/...", import.meta.url)`
    // с литеральным путём в этой же функции остаётся и это нормально.
    expect(body).not.toMatch(/new URL\(\s*f\s*,/);
  });
});

describe("tokenFromRequest держит свой контракт string | null", () => {
  test("пустое значение — это отсутствие токена", () => {
    expect(MiniAppSessionStore.tokenFromRequest(reqWithCookie(`${NAME}=`), FP)).toBeNull();
  });

  test("пустое значение среди других cookie тоже null", () => {
    const req = reqWithCookie(`other=1; ${NAME}=; third=3`);
    expect(MiniAppSessionStore.tokenFromRequest(req, FP)).toBeNull();
  });

  test("обычный токен читается", () => {
    const store = new MiniAppSessionStore();
    const token = store.issue(4242, FP)!;
    expect(MiniAppSessionStore.tokenFromRequest(reqWithCookie(`${NAME}=${token}`), FP)).toBe(
      token,
    );
  });

  test("знаки равенства внутри значения сохраняются", () => {
    const req = reqWithCookie(`${NAME}=YWJj==`);
    expect(MiniAppSessionStore.tokenFromRequest(req, FP)).toBe("YWJj==");
  });

  test("пустая строка не проходит validate — дыры не было и нет", () => {
    const store = new MiniAppSessionStore();
    expect(store.validate("", 4242, FP)).toBe(false);
    expect(store.validate(null, 4242, FP)).toBe(false);
  });
});

describe("мёртвая hardSlice удалена", () => {
  const SRC = stripComments(
    readFileSync(join(import.meta.dir, "..", "lib", "telegram-chunking.ts"), "utf8"),
  );

  test("объявления не осталось", () => {
    const offenders = SRC.split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes("hardSlice"));
    expect(offenders).toEqual([]);
  });

  test("резка длинной строки с непарным фенсом всё ещё в пределах лимита", () => {
    // Контроль: удаляли мёртвое, живое не тронули. Одна строка без переносов,
    // с непарным ``` — ровно тот вход, ради которого ветку переписали на цикл.
    const line = "```js " + "https://x.tld/aaaaaaaaaaaaaaaaaaaa ".repeat(400);
    const parts = splitForTelegram(line, 4096);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4096);
    for (const p of parts) expect(p.trim()).not.toBe("");
  });
});
