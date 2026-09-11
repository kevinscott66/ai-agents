/**
 * Async memory operations layer - replaces sync FS calls in memory.ts hot path.
 * 
 * This module provides async equivalents of memory.ts functions to avoid blocking
 * the event loop during file operations in action-dispatch.ts and other hot paths.
 * 
 * See T-303 for context on removing synchronous FS from hot path.
 *
 * Разбор slug → путь и канонический ключ берутся из memory.ts, своих копий
 * здесь нет. Копия была — и уже разошлась с оригиналом: фикс канонического
 * ключа 2026-08-08 доехал только до memory.ts, а через async идёт WRITE_WIKI,
 * то есть все записи агентов. Теперь и ключ (`upsertWikiFts`), и путь
 * (`pagePath`) выводятся в одном месте.
 */
import { readFile, writeFile, appendFile, mkdir, access, open, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import {
  type Scope,
  sanitizeWikiContent,
  prepareWikiPage,
  upsertWikiFts,
  pagePath,
  pageTmpPath,
  dropPartialFirstLine,
  buildWikiIndex,
  WIKI_LOG_TAIL_BYTES,
  trimWikiLog,
} from "./memory.ts";
import { join } from "node:path";
import { resolveMemoryDir } from "./memory-dir.ts";

const MEMORY_DIR = resolveMemoryDir(process.env.MEMORY_DIR);

function scopeDir(scope: Scope): string {
  return join(MEMORY_DIR, scope);
}

/**
 * Async version of wikiRead
 */
export async function wikiReadAsync(scope: Scope, slug: string): Promise<string | null> {
  const p = pagePath(scope, slug);
  try {
    await access(p, constants.F_OK);
    return await readFile(p, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Async version of wikiIndex
 */
export async function wikiIndexAsync(scope: Scope): Promise<string> {
  const p = join(scopeDir(scope), "index.md");
  try {
    await access(p, constants.F_OK);
    const s = await readFile(p, "utf8");
    if (s.trim()) return s;
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  // Тот же генератор, что у синхронного близнеца. Отдельная реализация здесь
  // уже однажды разошлась с memory.ts (см. upsertWikiFts, аудит 2026-08-10), а
  // именно этот путь — основной: им ходит message-handler всех 12 ролей.
  return buildWikiIndex(scope);
}

/**
 * Последние maxBytes байт файла, обрезанные по границе строки.
 *
 * Размер берётся у ОТКРЫТОГО дескриптора, а не у пути, и это не стилистика.
 * Аудит 2026-08-21: было `stat(p)` → `open(p)` → `read`, то есть размер
 * считался по одному иноду, а читали из другого. `trimWikiLog` подменяет
 * `log.md` через `rename` (мегабайт → 64 KB); попади подрезка между этими
 * двумя `await` — смещение `size - maxBytes` оказывается за EOF нового файла,
 * `bytesRead` равен нулю, и наружу уходит пустая строка. Читатель видел не
 * «старый файл целиком» и не «новый целиком», а ничего — при том что ради
 * этого самого обещания подрезка и сделана через `rename`.
 *
 * С `fh.stat()` окна нет вовсе: `rename` не трогает уже открытый инод, а
 * дописка в него может только удлинить файл, то есть хвост останется в
 * пределах прочитанного. Синхронный близнец (`readTail` в memory.ts) от этого
 * защищён самой синхронностью — между его тремя вызовами fs не выполняется
 * ничего.
 */
async function readTailAsync(p: string, maxBytes: number): Promise<string> {
  const fh = await open(p, "r");
  try {
    const size = (await fh.stat()).size;
    if (size <= maxBytes) return await fh.readFile("utf8");
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, size - maxBytes);
    return dropPartialFirstLine(buf.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await fh.close();
  }
}

/**
 * Async version of wikiLog.
 *
 * Политика чтения общая с синхронной половиной: тот же хвост, та же обрезка по
 * границе строки, те же константы. Разъезд этой пары уже стоил двух багов
 * (upsertWikiFts, pagePath), поэтому дублируется только вызов fs, но не решение
 * о том, сколько читать.
 */
export async function wikiLogAsync(scope: Scope): Promise<string> {
  const p = join(scopeDir(scope), "log.md");
  try {
    await access(p, constants.F_OK);
    return await readTailAsync(p, WIKI_LOG_TAIL_BYTES);
  } catch (err: any) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Async version of wikiAppendLog
 */
export async function wikiAppendLogAsync(scope: Scope, line: string, agentKey: string): Promise<void> {
  if (!line || typeof line !== "string") return;
  const p = join(scopeDir(scope), "log.md");
  await mkdir(dirname(p), { recursive: true });
  const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
  // Sanitize user-PII patterns before persisting to wiki log
  const safeLine = sanitizeWikiContent(line).replace(/\n/g, " ").slice(0, 240);
  await appendFile(p, `\n${ts} | ${agentKey} | ${safeLine}`);
  // Аудит 2026-08-12: здесь стояла вторая, отдельно написанная подрезка —
  // `stat` → чтение хвоста → `writeFile`, три `await` подряд. Всё, что успело
  // дописаться в этот промежуток, затиралось копией, прочитанной до него; плюс
  // она молча глотала ошибку там, где синхронная предупреждает в лог. Зовём
  // общую: подрезка случается раз на мегабайт лога, и синхронные 64 KB в этой
  // точке дешевле разъезда двух копий одного правила.
  trimWikiLog(p);
}

/**
 * Async version of wikiWrite - the key function used in action-dispatch hot path
 */
export async function wikiWriteAsync(args: {
  scope: Scope;
  slug: string;
  title: string;
  content: string;
}): Promise<void> {
  const p = pagePath(args.scope, args.slug);
  await mkdir(dirname(p), { recursive: true });
  // Sanitize user-PII patterns before persisting to wiki + FTS index.
  // Заголовок чистится тем же фильтром и приводится к одной строке — правило
  // общее с синхронным писателем, см. prepareWikiPage в memory.ts.
  const { safeTitle, safeContent, body } = prepareWikiPage(args.title, args.content);
  // Временный файл + rename — правило общее с синхронным писателем, см.
  // writePageAtomic в memory.ts (там же — что именно это чинит, а что нет).
  // Реализация всё же своя: writePageAtomic синхронен, а этот путь — горячий,
  // ради того его сюда и вынесли (T-303).
  const tmp = pageTmpPath(p);
  try {
    await writeFile(tmp, body);
    await rename(tmp, p);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }

  // FTS5 upsert — общий с wikiWrite: ключ канонизируется из пути файла, а не
  // берётся у вызывающего. Своя копия этой логики тут и разошлась с синхронной
  // (аудит 2026-08-10), поэтому копии больше нет.
  upsertWikiFts(args.scope, args.slug, p, safeTitle, safeContent);
}