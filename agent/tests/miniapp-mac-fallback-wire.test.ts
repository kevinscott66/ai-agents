import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../miniapp/src/pages/Mac.tsx", import.meta.url), "utf8");
test("Mac launch wires checkbox state to explicit boolean and retains initial provider", () => {
  expect(source).toContain("const [allowFallback, setAllowFallback] = useState(true)");
  expect(source).toContain('checked={provider === "claude" && allowFallback}');
  expect(source).toContain("setAllowFallback(e.currentTarget.checked)");
  // Evaluate the production wire expression for both selections and toggle positions.
  const payload = source.match(/postMessage\((\{macStart:.*?\})\);/)?.[1];
  expect(payload).toBeDefined();
  const encode = new Function("provider", "allowFallback", "project", "prompt", `return ${payload}`);
  for (const provider of ["claude", "codex"]) {
    for (const enabled of [true, false]) {
      expect(encode(provider, enabled, " app ", " task ")).toEqual({macStart:{provider, allowFallback:provider === "claude" && enabled, project:"app", prompt:"task"}});
    }
  }
});
