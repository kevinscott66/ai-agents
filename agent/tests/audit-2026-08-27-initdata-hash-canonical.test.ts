/**
 * Аудит 2026-08-27: `verifyInitData` принимал hash в любом регистре.
 *
 * `Buffer.from(hash, "hex")` регистр игнорирует, поэтому одна и та же подпись
 * проходила проверку в 2^31 написаниях (столько hex-букв в типичном hash).
 * Подпись этим не обходилась — обходилось всё, что метит initData ПО СТРОКЕ
 * hash: одноразовость мутаций (`MiniAppSessionStore.fingerprint` склеивает
 * `query_id + "\n" + hash`) считала каждое написание новым предъявлением, то
 * есть одна перехваченная initData давала неограниченный replay на все 24 часа
 * жизни `auth_date` вместо ровно одного.
 *
 * Фикс: `hash` обязан быть каноничным строчным hex длины 64.
 */
import { describe, expect, test } from "bun:test";
import { buildInitData, verifyInitData } from "../lib/miniapp-auth.ts";

const TOKEN = "123456:TEST-TOKEN-not-a-real-secret";

function freshInitData(): { raw: string; hash: string } {
  const raw = buildInitData(TOKEN, {
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: "AAF_canonical_probe",
    user: JSON.stringify({ id: 777_027, username: "probe" }),
  });
  return { raw, hash: new URLSearchParams(raw).get("hash")! };
}

function withHash(raw: string, hash: string): string {
  const sp = new URLSearchParams(raw);
  sp.set("hash", hash);
  return sp.toString();
}

describe("initData hash must be canonical lowercase hex", () => {
  test("контроль: каноничный hash по-прежнему принимается", () => {
    const { raw } = freshInitData();
    const res = verifyInitData(raw, TOKEN);
    expect(res.ok).toBe(true);
  });

  test("hash в верхнем регистре отвергается", () => {
    const { raw, hash } = freshInitData();
    const upper = hash.toUpperCase();
    // Предусловие: написание действительно другое, иначе тест ничего не ловит.
    expect(upper).not.toBe(hash);

    const res = verifyInitData(withHash(raw, upper), TOKEN);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("bad hash");
  });

  test("достаточно одной поднятой буквы, чтобы получить новый ключ — тоже отвергается", () => {
    const { raw, hash } = freshInitData();
    const flipped = hash.replace(/[a-f]/, (c) => c.toUpperCase());
    expect(flipped).not.toBe(hash);

    const res = verifyInitData(withHash(raw, flipped), TOKEN);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("bad hash");
  });

  test("не-hex, короткий и длинный hash отвергаются одинаковой причиной", () => {
    const { raw, hash } = freshInitData();
    for (const bad of ["z".repeat(64), hash.slice(0, 63), hash + "a"]) {
      const res = verifyInitData(withHash(raw, bad), TOKEN);
      expect(res.ok).toBe(false);
      expect(res.ok === false && res.reason).toBe("bad hash");
    }
  });

  test("канонизация не подменяет проверку подписи: валидный по форме, но чужой hash отвергается", () => {
    const { raw } = freshInitData();
    const res = verifyInitData(withHash(raw, "0".repeat(64)), TOKEN);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe("bad hash");
  });
});
