import { expect, test } from "bun:test";
import { ROLE_TIERS, roleModel } from "../lib/role-models.ts";
import { codexEffort } from "../lib/codex-runtime.ts";

test("lead gets the strongest model on every path", () => {
  expect(roleModel("orchestrator", "api", {})).toEqual({ model: "claude-opus-5", effort: "high" });
  expect(roleModel("orchestrator", "sdk", {})).toEqual({ model: "claude-opus-5", effort: "high" });
  expect(roleModel("orchestrator", "codex", {})).toEqual({ model: "gpt-5.6-sol", effort: "high" });
});

test("every team role has a tier; writing roles think less", () => {
  for (const key of ["orchestrator", "pm", "product", "backend", "frontend", "tgdev", "aieng", "qa", "smm", "copy", "design", "perm"]) {
    expect(ROLE_TIERS[key]).toBeDefined();
  }
  expect(roleModel("backend", "sdk", {})).toEqual({ model: "claude-sonnet-5", effort: "high" });
  expect(roleModel("smm", "codex", {})).toEqual({ model: "gpt-5.6-terra", effort: "medium" });
});

test("role env overrides the table, global env does not", () => {
  const env = { ANTHROPIC_LARGE_MODEL: "claude-sonnet-4-6", ANTHROPIC_LARGE_MODEL_QA: " claude-opus-5 ", AGENT_EFFORT_QA: "max" };
  expect(roleModel("qa", "api", env)).toEqual({ model: "claude-opus-5", effort: "max" });
  expect(roleModel("pm", "api", env)).toEqual({ model: "claude-sonnet-5", effort: "medium" });
  expect(roleModel("qa:svg-fallback", "codex", { CODEX_MODEL_QA_SVG_FALLBACK: "gpt-5.6-luna" })).toEqual({ model: "gpt-5.6-luna" });
});

test("unknown keys keep the caller's choice; bad effort fails loudly", () => {
  expect(roleModel("_compactor", "sdk", {})).toEqual({});
  expect(roleModel(undefined, "api", {})).toEqual({});
  expect(roleModel("toString", "api", {})).toEqual({});
  expect(() => roleModel("qa", "api", { AGENT_EFFORT_QA: "ultra" })).toThrow("AGENT_EFFORT_QA");
});

test("codex effort is passed only when the model supports it", () => {
  const catalog = { models: [{ slug: "a", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }, { slug: "b" }] };
  expect(codexEffort(catalog, "a", "high")).toBe("high");
  expect(codexEffort(catalog, "a", "max")).toBeUndefined();
  expect(codexEffort(catalog, "b", "high")).toBeUndefined();
  expect(codexEffort(catalog, "a")).toBeUndefined();
});

test("sdkRoleOptions: table roles pick their alias, others fall back to ANTHROPIC_LARGE_MODEL_SDK", async () => {
  const { sdkRoleOptions } = await import("../lib/agent-sdk-runtime.ts");
  const saved = process.env.ANTHROPIC_LARGE_MODEL_SDK;
  process.env.ANTHROPIC_LARGE_MODEL_SDK = "haiku";
  try {
    expect(sdkRoleOptions("orchestrator")).toEqual({ model: "claude-opus-5", effort: "high" });
    expect(sdkRoleOptions("_sdk")).toEqual({ model: "haiku" });
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_LARGE_MODEL_SDK;
    else process.env.ANTHROPIC_LARGE_MODEL_SDK = saved;
  }
});
