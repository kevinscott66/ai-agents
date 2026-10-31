/** Read the first balanced object from model prose without evaluating its content.
 * A malformed first object is an error; never search ahead for a nicer response.
 * Callers must validate their own schema before using any values.
 */
export function extractModelObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  if (start < 0) throw new Error("в ответе модели нет JSON-объекта");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(raw.slice(start, i + 1));
  }
  throw new Error("незакрытые скобки JSON");
}
