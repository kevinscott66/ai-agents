/**
 * Аудит 2026-08-20: ни одно сообщение Mini App не доходило до скринридера.
 *
 * `toast()` — единственный канал коротких сообщений в Mini App: «Только для
 * админа», «Не удалось: N из M», сырой текст ошибки сервера, «Настройки
 * сохранены». Хост тостов рисовал обычный `<div class="toast-host">` без
 * какой-либо live-region разметки, а соседний `ErrorBox` — с `role="alert"`.
 * То есть внутри одного приложения одна половина сообщений об ошибках
 * озвучивалась, а другая молчала.
 *
 * Хуже того, хост делал `if (items.length === 0) return null` — контейнер
 * исчезал из DOM, когда тостов нет. Даже если бы на нём стоял `aria-live`,
 * это бы не помогло: регион, который появляется в DOM одновременно со своим
 * содержимым, скринридеры не объявляют. Живой регион должен быть смонтирован
 * ЗАРАНЕЕ и пустым — тогда вставка узла внутрь него читается вслух.
 *
 * Проверять это без DOM непросто: у Mini App нет ни jsdom, ни happy-dom, а
 * `preact` лежит в `agent/miniapp/node_modules` и из `agent/tests` напрямую не
 * резолвится. Поэтому `ToastList` выделен как чистый компонент без хуков: его
 * можно вызвать обычной функцией и посмотреть возвращённое VNode-дерево —
 * `.type` и `.props`. Хуки остались в `ToastHost`.
 *
 * Это поведенческая проверка, а не проверка текста файла: она читает то же
 * дерево, которое preact отдаст в DOM.
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ToastList } from "../miniapp/src/components/Toast.tsx";

const SRC = readFileSync(
  join(import.meta.dir, "..", "miniapp", "src", "components", "Toast.tsx"),
  "utf8",
);

/** Убирает комментарии, чтобы утверждения по исходнику не ловили этот же docblock. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

type VNode = { type: unknown; props: Record<string, any> };

function childrenOf(v: VNode): VNode[] {
  const c = v.props.children;
  if (c === undefined || c === null) return [];
  return (Array.isArray(c) ? c.flat(Infinity) : [c]).filter(
    (x): x is VNode => !!x && typeof x === "object",
  );
}

const ITEMS = [
  { id: 1, message: "Настройки сохранены", kind: "success" as const },
  { id: 2, message: "Не удалось: 3 из 5", kind: "error" as const },
];

describe("Mini App: тосты и скринридер", () => {
  test("контейнер существует, даже когда тостов нет", () => {
    const v = ToastList({ items: [] }) as VNode | null;
    // Суть фикса: пустой регион должен быть смонтирован заранее.
    expect(v).not.toBe(null);
    expect(v!.type).toBe("div");
    expect(childrenOf(v!)).toEqual([]);
  });

  test("пустой контейнер — это live-region", () => {
    const v = ToastList({ items: [] }) as VNode;
    expect(v.props.role).toBe("status");
    expect(v.props["aria-live"]).toBe("polite");
  });

  test("непустой контейнер — тот же live-region", () => {
    const v = ToastList({ items: ITEMS }) as VNode;
    expect(v.props.role).toBe("status");
    expect(v.props["aria-live"]).toBe("polite");
    // Объявляется только добавленный узел, а не весь список заново.
    expect(v.props["aria-atomic"]).toBe("false");
  });

  test("класс контейнера не изменился — вёрстка на месте", () => {
    for (const items of [[], ITEMS]) {
      const v = ToastList({ items }) as VNode;
      expect(v.props.className).toBe("toast-host");
    }
  });

  test("каждый тост отрисован и текст на месте", () => {
    const v = ToastList({ items: ITEMS }) as VNode;
    const kids = childrenOf(v);
    expect(kids.length).toBe(2);
    const flat = JSON.stringify(kids.map((k) => k.props.children));
    expect(flat).toContain("Настройки сохранены");
    expect(flat).toContain("Не удалось: 3 из 5");
  });

  test("класс тоста по-прежнему несёт вид сообщения", () => {
    const kids = childrenOf(ToastList({ items: ITEMS }) as VNode);
    expect(kids[0]!.props.className).toBe("toast success");
    expect(kids[1]!.props.className).toBe("toast error");
  });

  test("контроль: харнесс действительно читает атрибуты, а не выдумывает их", () => {
    // Если бы childrenOf/props читались неправильно, проверки выше проходили бы
    // вхолостую. Внутренние тосты никаких live-атрибутов нести не должны —
    // вложенные live-region дают либо двойное объявление, либо ни одного.
    const kids = childrenOf(ToastList({ items: ITEMS }) as VNode);
    for (const k of kids) {
      expect(k.props["aria-live"]).toBeUndefined();
      expect(k.props.role).toBeUndefined();
    }
  });

  test("пустой контейнер не перехватывает касания", () => {
    // Раньше хост исчезал из DOM, когда тостов нет; теперь он висит всегда.
    // Это безопасно ровно до тех пор, пока правило `.toast-host` держит
    // `pointer-events: none`: без него прозрачная полоса во всю ширину над
    // нижней навигацией съедала бы тапы на каждом экране.
    const css = readFileSync(
      join(import.meta.dir, "..", "miniapp", "src", "styles.css"),
      "utf8",
    );
    const rule = css.slice(css.indexOf(".toast-host {"));
    expect(rule.startsWith(".toast-host {")).toBe(true);
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toContain("pointer-events: none");
  });

  test("ToastHost отдаёт разметку через ToastList и не прячет контейнер", () => {
    const src = stripComments(SRC);
    // Гарантия, что stripComments не съел код под проверкой.
    expect(src).toContain("export function ToastList");
    expect(src).toContain("<ToastList");
    // Ранний выход, из-за которого регион исчезал из DOM, должен исчезнуть сам.
    expect(src).not.toContain("items.length === 0) return null");
  });
});
