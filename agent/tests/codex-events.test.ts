import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexEvents } from "../lib/codex-events.ts";
import { readBoundedUtf8 } from "../lib/read-bounded-utf8.ts";
const completion = (input_tokens: number) => JSON.stringify({type: "turn.completed", usage: {input_tokens, output_tokens: 4}});
test("completion charges once; duplicate and invalid accounting fail closed", () => {
  let charged = 0;
  const events = new CodexEvents((i, o) => { charged += i + o; });
  expect(() => events.accept(completion(-1))).toThrow("Invalid Codex usage");
  expect(events.completed).toBe(false);
  events.accept(completion(8));
  expect(charged).toBe(12);
  expect(() => events.accept(completion(8))).toThrow("Duplicate");
  expect(charged).toBe(12);
});
test("native tool events and invalid JSON never become successful completion", () => {
  for (const input of ['{', JSON.stringify({item:{type:'command_execution'}}), JSON.stringify({type:'turn.failed'})]) {
    const events = new CodexEvents();
    expect(() => events.accept(input)).toThrow();
    expect(events.completed).toBe(false);
  }
});
test("bounded output uses bytes and accepts the exact limit", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-bounded-'));
  try {
    const file = join(dir, 'reply');
    await writeFile(file, 'Я');
    expect(await readBoundedUtf8(file, 2)).toBe('Я');
    await expect(readBoundedUtf8(file, 1)).rejects.toThrow('too large');
    await writeFile(file, '');
    expect(await readBoundedUtf8(file, 0)).toBe('');
  } finally { await rm(dir, {recursive:true,force:true}); }
});
