/** Native HTTP inputs have both a byte ceiling and a wall-clock deadline. */
export async function readNativeJson(req: Request, timeoutMs = 5_000, maxBytes = 65_536): Promise<Record<string, unknown>> {
  if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new Error('json_required');
  // 8,000 UTF-16 units may expand to 48,000 bytes when JSON-escaped.
  if (Number(req.headers.get('content-length')) > maxBytes) throw new Error('body_too_large');
  if (!req.body) throw new Error('invalid_body');
  const reader = req.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const deadline = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('body_aborted'));
    req.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => reject(new Error('body_timeout')), timeoutMs);
    if (req.signal.aborted) abort();
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('body_too_large');
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body');
    return value as Record<string, unknown>;
  } catch (error) {
    // A malicious stream's cancel() may never resolve; cleanup must not await it.
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    req.signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
