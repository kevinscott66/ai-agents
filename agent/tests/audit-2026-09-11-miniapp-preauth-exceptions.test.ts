/**
 * Аудит 2026-09-11: модульный докблок lib/miniapp-server.ts недосчитался входа.
 *
 * Докблок описывает стену аутентификации (`const auth = authOr401(req, url)`) и
 * перечисляет маршруты под /api/, которые отвечают ДО неё. Список назывался
 * «Исключений ДВА» — /api/events и /api/health, — а ветка `OPTIONS` стоит на
 * четыре строки РАНЬШЕ обеих и тоже отвечает без initData. Сам файл ниже, там
 * где считается `preAuth` для лога, OPTIONS перечисляет.
 *
 * Эксплуатации нет: OPTIONS отдаёт 204 с пустым телом и corsHeaders(), ни
 * данных, ни мутаций — это корректный CORS-preflight. Цена дефекта в другом:
 * докблок сам предупреждает «пересчитывать список надо каждый раз», и именно
 * по этому описанию аудит решает, что проверять. Список уже был «все», потом
 * «ровно одно», потом «два» — каждый раз мимо.
 *
 * Поэтому сторож не про текст, а про сверку текста с кодом: сколько веток под
 * /api/ реально стоит выше стены и названа ли каждая.
 *
 * Круг 42: шапку дополнили вторым списком — что сервер исполняет сам, — и
 * сторож упал, потому что считал буллеты всей шапки, а не буллеты своего
 * списка. Ошибка того же рода, что и ловимая: счёт вёлся не по тому, про что
 * утверждение. Теперь список выбирается вводной фразой.
 *
 * ЧЕГО СТОРОЖ НЕ ДЕЛАЕТ. Он не проверяет маршруты вне /api/ (`/healthz`,
 * `/metrics`, `/readyz`, статика) — докблок про них не говорит, и они
 * аутентификации и не обещают. Он не проверяет, что сама стена достаточна, и
 * не разбирает ветки, где путь собирается из переменной: pattern-маршруты
 * (regex) стоят ниже стены, и если такой поставят выше, тест этого не увидит.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(
  join(import.meta.dir, "..", "lib", "miniapp-server.ts"),
  "utf8",
);
const LINES = SRC.split("\n");

const WALL = LINES.findIndex((l) => l.includes("const auth = authOr401(req, url);"));
const ROUTE = LINES.findIndex((l) => l.includes("async function route("));
const PRE_WALL = LINES.slice(ROUTE, WALL).join("\n");

/**
 * Строки-буллеты того списка модульного докблока, который вводит `intro`.
 *
 * Круг 42: раньше брались ВСЕ буллеты шапки. Пока список в ней был один, это
 * совпадало; когда рядом появился второй — перечень того, что сервер
 * исполняет сам, — счёт поехал, и сторож стал отвечать про сумму двух
 * списков, то есть про не тот список. Границу списка задаёт отступ: строки
 * продолжения буллета идут с отступом от `*`, обычная проза — сразу за ним.
 */
function docBullets(intro = "Исключений"): string[] {
  const head = SRC.slice(0, SRC.indexOf("*/")).split("\n");
  const from = head.findIndex((l) => l.includes(intro));
  if (from < 0) return [];
  const out: string[] = [];
  for (const l of head.slice(from + 1)) {
    if (l.includes("•")) out.push(l.replace(/^\s*\*\s*/, "").trim());
    else if (out.length === 0) continue;
    else if (/^\s*\*\s{3,}\S/.test(l)) continue;
    else break;
  }
  return out;
}

const NUMERALS: Record<string, number> = {
  ОДНО: 1,
  ДВА: 2,
  ТРИ: 3,
  ЧЕТЫРЕ: 4,
  ПЯТЬ: 5,
};

describe("докблок miniapp-server сходится со стеной authOr401", () => {
  test("предпосылка: стена и начало route() найдены, стена ниже начала", () => {
    expect(ROUTE).toBeGreaterThan(0);
    expect(WALL).toBeGreaterThan(ROUTE);
  });

  test("прописью названо ровно столько исключений, сколько буллетов", () => {
    const m = SRC.slice(0, SRC.indexOf("*/")).match(/Исключений\s+([А-ЯЁ]+)/);
    expect(m).toBeTruthy();
    const claimed = NUMERALS[m![1]!];
    expect(claimed).toBeDefined();
    expect(docBullets().length).toBe(claimed);
  });

  test("каждая ветка под /api/ выше стены названа в докблоке", () => {
    const found = new Set<string>();
    for (const m of PRE_WALL.matchAll(/path === "(\/api\/[a-z0-9/-]+)"/g)) {
      found.add(m[1]!);
    }
    // Два входа известны; если появится третий, он обязан быть в докблоке.
    expect(found.has("/api/health")).toBe(true);
    expect(found.has("/api/events")).toBe(true);
    const doc = docBullets().join("\n");
    for (const p of found) expect(doc).toContain(p);
  });

  test("ветка OPTIONS выше стены — и она тоже названа", () => {
    expect(PRE_WALL).toContain('method === "OPTIONS"');
    expect(docBullets().some((b) => b.includes("OPTIONS"))).toBe(true);
  });

  test("докблок не называет входа, которого нет выше стены", () => {
    for (const b of docBullets()) {
      const p = b.match(/(\/api\/[a-z0-9/-]+)/);
      if (p) {
        expect(PRE_WALL).toContain(`path === "${p[1]}"`);
      } else {
        // Единственный неадресный буллет — это OPTIONS.
        expect(b).toContain("OPTIONS");
      }
    }
  });

  test("буллеты соседнего списка шапки в счёт не идут", () => {
    // Круг 42: перечень исполняемых сервером маршрутов — такие же буллеты в
    // той же шапке. Сторож обязан видеть только те, что стоят под «Исключений».
    const all = (SRC.slice(0, SRC.indexOf("*/")).match(/•/g) ?? []).length;
    const own = docBullets();
    const neighbour = docBullets("Исполняет сервер");
    expect(neighbour.length).toBeGreaterThan(0);
    expect(own.length + neighbour.length).toBe(all);
    expect(own.join("\n")).not.toContain("/api/mac/stop");
  });

  test("OPTIONS отвечает 204 без тела — почему это не дыра", () => {
    expect(PRE_WALL).toMatch(
      /method === "OPTIONS"\)\s*\{\s*\n\s*return new Response\(null, \{ status: 204, headers: corsHeaders\(\) \}\);/,
    );
  });
});
