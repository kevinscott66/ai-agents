import { describe, expect, test } from "bun:test";
import type { VNode } from "preact";
import { renderRichInline, renderRichBlock } from "./RichText";

// Хелпер: узлы могут быть строками или Preact VNode ({ type, props }).
function isVNode(n: unknown): n is VNode {
  return typeof n === "object" && n !== null && "type" in (n as object);
}

describe("renderRichInline", () => {
  test("**x** → <strong>x</strong>", () => {
    const nodes = renderRichInline("a **bold** b");
    const strong = nodes.find(
      (n) => isVNode(n) && n.type === "strong",
    ) as VNode;
    expect(strong).toBeDefined();
    expect(strong.props.children).toBe("bold");
    // Окружающий текст сохранён.
    expect(nodes).toContain("a ");
    expect(nodes).toContain(" b");
  });

  test("[t](https://a) → <a href> с safeHref", () => {
    const nodes = renderRichInline("see [docs](https://example.com/x) now");
    const a = nodes.find((n) => isVNode(n) && n.type === "a") as VNode;
    expect(a).toBeDefined();
    expect(a.props.href).toBe("https://example.com/x");
    expect(a.props.target).toBe("_blank");
    expect(a.props.rel).toBe("noopener noreferrer");
    expect(a.props.children).toBe("docs");
  });

  test("[t](javascript:..) → без href, просто текст", () => {
    // Внимание: TOKEN_RE matches только http(s) url, поэтому javascript:
    // вообще не матчится как ссылка — остаётся сырым текстом (без href).
    const nodes = renderRichInline("[click](javascript:alert(1))");
    // Никаких <a> узлов.
    expect(nodes.some((n) => isVNode(n) && n.type === "a")).toBe(false);
    // Текст присутствует как обычная строка.
    expect(nodes.join("")).toContain("click");
  });

  test("обычный текст возвращается как есть", () => {
    const nodes = renderRichInline("plain text only");
    expect(nodes).toEqual(["plain text only"]);
  });

  test("ссылка + жирный в одной строке", () => {
    const nodes = renderRichInline("**A** and [B](https://b.io)");
    expect(nodes.some((n) => isVNode(n) && n.type === "strong")).toBe(true);
    expect(nodes.some((n) => isVNode(n) && n.type === "a")).toBe(true);
  });
});

describe("renderRichBlock", () => {
  test("разбивает по пустым строкам на <p>", () => {
    const out = renderRichBlock("para one\n\npara two") as VNode[];
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(2);
    expect(out[0].type).toBe("p");
    expect(out[1].type).toBe("p");
  });

  test("пустой текст → null", () => {
    expect(renderRichBlock("   ")).toBeNull();
  });
});
