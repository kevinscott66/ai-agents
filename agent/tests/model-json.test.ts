import { describe, expect, test } from "bun:test";
import { extractModelObject } from "../lib/model-json.ts";
import { extractJson } from "../tools/site-editorial.ts";

describe("shared model JSON boundary", () => {
  test("site keeps its public parser API with nested content and prose wrappers", () => {
    const value = { body: 'Текст {внутри}, "кавычки", слэш \\ и }', nested: { items: [1, { n: 2 }] } };
    const response = `Ответ:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\nКонец`;
    expect(extractModelObject(response)).toEqual(value);
    expect(extractJson(response)).toEqual(value);
  });

  test("odd and even runs of escapes do not end JSON strings early", () => {
    for (let n = 0; n <= 6; n++) {
      const value = { text: "\\".repeat(n) + '" } { русский текст', tail: "ok" };
      expect(extractModelObject(JSON.stringify(value))).toEqual(value);
    }
  });

  test("only the first complete object is used, not an appended alternative", () => {
    expect(extractModelObject('{"defer":true}\n{"title":"Publish instead"}')).toEqual({ defer: true });
  });

  test("malformed first objects are not repaired by scanning later text", () => {
    for (const raw of ["no JSON", "null", "[]", '{"body":"unfinished', '{"a":1', '{not JSON}\n{"a":1}', '{"body":"bad\\q"}'])
      expect(() => extractModelObject(raw)).toThrow();
  });
});
