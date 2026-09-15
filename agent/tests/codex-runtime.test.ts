import { describe, test, expect } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { parseCodexReply, inferenceCatalog } from "../lib/codex-runtime.ts";
import { inferenceProvider } from "../lib/inference-provider.ts";
const params: Anthropic.MessageCreateParamsNonStreaming = {
  model: "test", max_tokens: 100, messages: [{role: "user", content: "hello"}],
  tools: [{name: "READ_WIKI", input_schema: {type: "object", properties: {path: {type: "string"}}}}],
};
const reply = (name: string, arguments_json = '{}') => JSON.stringify({text: "", tool_calls: [{name, arguments_json}]});
describe("Codex inference boundary", () => {
  test("switch is reversible and unknown providers fail closed", () => {
    expect(inferenceProvider({})).toBe("claude");
    expect(inferenceProvider({AGENT_PROVIDER: "codex"})).toBe("codex");
    expect(inferenceProvider({AGENT_PROVIDER: "claude"})).toBe("claude");
    expect(() => inferenceProvider({AGENT_PROVIDER: "other"})).toThrow();
  });
  test("accepts text and dispatcher-compatible tool proposals", () => {
    expect(parseCodexReply('{"text":"hello","tool_calls":[]}', params)[0].type).toBe("text");
    const tool = parseCodexReply(reply("READ_WIKI", '{"path":"x"}'), params)[0];
    expect(tool.type).toBe("tool_use");
    if (tool.type === "tool_use") expect(tool.input).toEqual({path: "x"});
  });
  test("rejects unexposed tools and malformed arguments", () => {
    for (const raw of [reply("Bash"), reply("READ_WIKI", '[]'), reply("READ_WIKI", 'null'), reply("READ_WIKI", '{')]) {
      expect(() => parseCodexReply(raw, params)).toThrow();
    }
    expect(() => parseCodexReply(reply("READ_WIKI"), {...params, tools: []})).toThrow();
  });
  test("enforces required, named and prohibited tool choices", () => {
    expect(() => parseCodexReply('{"text":"done","tool_calls":[]}', {...params, tool_choice: {type: "any"}})).toThrow();
    expect(() => parseCodexReply(reply("READ_WIKI"), {...params, tool_choice: {type: "none"}})).toThrow();
    expect(() => parseCodexReply(reply("READ_WIKI"), {...params, tool_choice: {type: "tool", name: "OTHER"}})).toThrow();
    expect(parseCodexReply(reply("READ_WIKI"), {...params, tool_choice: {type: "tool", name: "READ_WIKI"}})).toHaveLength(1);
  });
});

import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("completed invalid turns are charged; CLI cannot inherit service secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-test-"));
  try {
    const fake = join(dir, "fake.ts");
    await writeFile(fake, `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0]==='--version') {console.log('codex-cli 0.149.0');process.exit(0); }\nif (args[0]==='debug') { console.log(JSON.stringify({models:[{slug:'test',visibility:'list',priority:1,apply_patch_tool_type:'freeform'}]}));process.exit(0); }\nif (process.env.TEST_SERVICE_SECRET || !args.includes('--ignore-user-config') || !args.includes('shell_tool')) process.exit(3);\nconst p = args[args.indexOf('--output-last-message')+1];\nawait Bun.write(p, JSON.stringify({text:'',tool_calls:[{name:'Bash',arguments_json:'{}'}]}));\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:123,output_tokens:45}}));\n`);
    await chmod(fake, 0o700);
    const runner = join(dir, "runner.ts");
    await writeFile(runner, `import {callCodex} from ${JSON.stringify(new URL("../lib/codex-runtime.ts", import.meta.url).pathname)};\nlet charged=0;\ntry {await callCodex(${JSON.stringify(params)}, (i,o)=>{charged=i+o}); process.exit(4);} catch(e){if(charged!==168) throw new Error('Usage missing: '+charged);}\nconsole.log('PASS');`);
    const proc = Bun.spawn([process.execPath, runner], {env: {...process.env, CODEX_BIN: fake, CODEX_AUTH_HOME: dir, TEST_SERVICE_SECRET: "not-a-real-secret"}, stdout: "pipe", stderr: "pipe"});
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    expect({code, err, out}).toEqual({code: 0, err: "", out: "PASS\n"});
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("catalog disables patch for all models and rejects unknown model fallback", () => {
  const raw = JSON.stringify({models:[{slug:"test",visibility:"list",priority:1,apply_patch_tool_type:"freeform"}]});
  const result = inferenceCatalog(raw);
  expect(result.model).toBe("test");
  expect(result.catalog.models[0].apply_patch_tool_type).toBeNull();
  expect(() => inferenceCatalog(raw,"unknown")).toThrow();
});

test("runtime fails closed on version, missing/duplicate usage and oversized replies; charges final unterminated usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-protocol-test-"));
  try {
    for (const scenario of ["version", "missing", "duplicate", "oversized", "unterminated", "native"]) {
      const fake = join(dir, `${scenario}.ts`);
      await writeFile(fake, `#!${process.execPath}
const args = process.argv.slice(2);
const scenario = ${JSON.stringify(scenario)};
if (args[0] === '--version') { console.log(scenario === 'version' ? 'codex-cli 0.150.0' : 'codex-cli 0.149.0'); process.exit(0); }
if (args[0] === 'debug') { console.log(JSON.stringify({models:[{slug:'test',visibility:'list',priority:1}]})); process.exit(0); }
await Bun.write(args[args.indexOf('--output-last-message')+1], scenario === 'oversized' ? 'x'.repeat(3*1024*1024) : JSON.stringify({text:'ok',tool_calls:[]}));
const event = JSON.stringify({type:'turn.completed',usage:{input_tokens:123,output_tokens:45}});
if (scenario === 'native') console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}}));
if (scenario !== 'missing') process.stdout.write(event + (scenario === 'unterminated' ? '' : '\\n'));
if (scenario === 'duplicate') console.log(event);
`);
      await chmod(fake, 0o700);
      const runner = join(dir, `runner-${scenario}.ts`);
      await writeFile(runner, `import {callCodex} from ${JSON.stringify(new URL("../lib/codex-runtime.ts", import.meta.url).pathname)};
let charged=0; let accepted=false;
try { await callCodex(${JSON.stringify(params)},(i,o)=>{charged+=i+o}); accepted=true; } catch {}
console.log(JSON.stringify({accepted,charged}));`);
      const proc = Bun.spawn([process.execPath, runner], { env: {...process.env, CODEX_BIN: fake, CODEX_AUTH_HOME: dir}, stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({scenario, code, err}).toEqual({scenario, code: 0, err: ""});
      const result = JSON.parse(out);
      expect(result.accepted).toBe(scenario === "unterminated");
      if (scenario !== "native") expect(result.charged).toBe(["version", "missing"].includes(scenario) ? 0 : 168);
    }
  } finally { await rm(dir, {recursive: true, force: true}); }
}, 15_000); // Six isolated multi-process scenarios may exceed the default 5s under build load.
