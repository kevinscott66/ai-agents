import { test, expect } from 'bun:test';
import { readNativeJson } from '../lib/native-request.ts';
const request = (body: BodyInit, headers = {}) => new Request('https://agent.test/api/native/pair', { method: 'POST', headers: {'content-type':'application/json', ...headers}, body });
test('native body has deadline and cancellation does not wait for hostile stream cleanup', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  await expect(readNativeJson(request(stream), 10)).rejects.toThrow('body_timeout');
  expect(cancelled).toBe(true);
});
test('native body checks actual bytes, object shape and declared size', async () => {
  await expect(readNativeJson(request('[]'))).rejects.toThrow('invalid_body');
  await expect(readNativeJson(request('null'))).rejects.toThrow('invalid_body');
  await expect(readNativeJson(request(JSON.stringify({text:'x'.repeat(70_000)})))).rejects.toThrow('body_too_large');
  await expect(readNativeJson(request('{}', {'content-length':'70000'}))).rejects.toThrow('body_too_large');
  expect(await readNativeJson(request('{"code":"abc"}'))).toEqual({code:'abc'});
});
test('native body abort interrupts a stalled read', async () => {
  const controller = new AbortController();
  const req = new Request('https://agent.test', { method:'POST', headers:{'content-type':'application/json'}, body:new ReadableStream(), signal:controller.signal });
  const reading = readNativeJson(req);
  controller.abort();
  await expect(reading).rejects.toThrow('body_aborted');
});


test('body bound accepts every supported UTF-16 text including multibyte and escaped characters', async () => {
  for (const text of ['界'.repeat(8000), '\u0001'.repeat(8000)]) {
    const body=JSON.stringify({id:'native-turn-0000001',conversationId:'native-dialog-00001',text});
    expect((await readNativeJson(request(body))).text).toBe(text);
  }
});
