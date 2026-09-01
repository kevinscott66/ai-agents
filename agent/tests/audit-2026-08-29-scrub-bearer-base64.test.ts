/**
 * Аудит 2026-08-29 — правило `Bearer …` в скраббере не знало алфавита base64.
 *
 * Класс значения был `[A-Za-z0-9._\-]+`: без `+`, `/` и `=`. На обычном
 * base64-токене прогон обрывался на первом же из них, и хвост ключа уезжал в
 * `agent_actions.error` и в снапшот health — то есть на диск в SQLite и наружу
 * админам через `/api/actions` и SSE.
 *
 * JWT'ы дыру не показывали: они base64url (`-`/`_`, без паддинга) и классом
 * покрывались целиком. Показывает её ровно тот вид значения, который выдаёт
 * `openssl rand -base64`.
 */
import { describe, test, expect } from "bun:test";
import { scrubSecretString } from "../lib/log.ts";

describe("аудит 2026-08-29: base64 в значении Authorization", () => {
  test("плюс, слэш и паддинг не обрывают вырезание", () => {
    // 44 символа — `openssl rand -base64 32`.
    const tok = "aGVsbG8+d29ybGQvdGhpcytpcy9hIHRlc3Qga2V5Pz0=";
    const out = scrubSecretString(`Authorization: Bearer ${tok}`);
    expect(out).toBe("Authorization: Bearer ***");
  });

  test("ни один фрагмент ключа не переживает", () => {
    const tok = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVor/Sg==";
    const out = scrubSecretString(`fetch failed: Bearer ${tok} (401)`);
    // Раньше уезжало всё после первого `+`.
    for (const frag of ["QUJD", "/Sg", "==", "+"]) {
      expect({ frag, leaked: out.includes(frag) }).toEqual({
        frag,
        leaked: false,
      });
    }
    expect(out).toBe("fetch failed: Bearer *** (401)");
  });

  test("Basic — тот же заголовок, тот же путь наружу", () => {
    const out = scrubSecretString("Authorization: Basic dXNlcjpwYXNzd29yZA==");
    expect(out).toBe("Authorization: Basic ***");
  });

  test("регистр слова не важен", () => {
    expect(scrubSecretString("authorization: bearer aGVsbG8+d29ybGQ=")).toBe(
      "authorization: bearer ***",
    );
  });

  test("границу значения задаёт пробел, а не первый спецсимвол", () => {
    const out = scrubSecretString("Bearer ab+cd/ef= затем обычный текст");
    expect(out).toBe("Bearer *** затем обычный текст");
  });

  test("прежние формы не сломаны", () => {
    expect(scrubSecretString("Authorization: Bearer abc.def-123")).toBe(
      "Authorization: Bearer ***",
    );
    // JWT: три сегмента через точку, base64url.
    expect(
      scrubSecretString("Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.q-_A9dZ"),
    ).toBe("Bearer ***");
  });

  test("текст после слова Bearer не съедается целиком", () => {
    // Расширение класса не должно превращать правило в «вырезать всё до конца
    // строки»: диагностику вокруг секрета читают.
    expect(scrubSecretString("Bearer token, повтор через 5с")).toBe(
      "Bearer ***, повтор через 5с",
    );
    expect(scrubSecretString("Bearer tok\nследующая строка")).toBe(
      "Bearer ***\nследующая строка",
    );
  });
});
