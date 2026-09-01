/**
 * Аудит 2026-08-28: IPv6-обёртки вокруг приватного IPv4 проходили насквозь.
 *
 * `isPrivateIPv6` знала три префикса — fc00::/7, fe80::/10, ff00::/8. Все три
 * опознаются по первому хекстету, и проверка ровно им и ограничивалась
 * (`host.split(":")[0]`). Туннельные и трансляционные префиксы устроены иначе:
 * адрес назначения лежит внутри адреса, а первый хекстет у них — обычный
 * публичный юникаст. `2002:c0a8:0101::` — это 192.168.1.1 через 6to4-релей,
 * `64:ff9b::7f00:1` на хосте с NAT64 — это 127.0.0.1.
 *
 * Путь эксплуатации не требует, чтобы агент сам такое написал: адрес
 * приезжает как AAAA-ответ на обычное имя, а `validatedTarget` прогоняет
 * каждый ответ DNS через ту же `blockedFetchReason`.
 */
import { describe, expect, test } from "bun:test";
import { blockedFetchReason, blockedFetchReasonAsync, parseIPv6 } from "../lib/sdk-web-guard.ts";

const reason = (addr: string) => blockedFetchReason(`http://[${addr}]/`);

describe("разбор IPv6", () => {
  test("сворачивание `::` разворачивается в 16 байт", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("2001:db8::1")?.slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
    expect(parseIPv6("fc00::")?.slice(0, 2)).toEqual([0xfc, 0x00]);
  });

  test("точечный хвост считается двумя хекстетами", () => {
    expect(parseIPv6("::ffff:127.0.0.1")?.slice(10)).toEqual([0xff, 0xff, 127, 0, 0, 1]);
  });

  test("мусор не разбирается", () => {
    expect(parseIPv6("")).toBeNull();
    expect(parseIPv6("gggg::1")).toBeNull();
    expect(parseIPv6("1:2:3:4:5:6:7")).toBeNull(); // без `::` нужно ровно 8 групп
    expect(parseIPv6("1::2::3")).toBeNull();
    expect(parseIPv6("fe80::1%eth0")).toBeNull(); // zone id — не наш случай
  });
});

describe("туннельные и трансляционные префиксы", () => {
  test("6to4 на приватный IPv4 закрыт, на публичный — нет", () => {
    expect(reason("2002:c0a8:0101::")).toContain("приватный");   // 192.168.1.1
    expect(reason("2002:7f00:0001::")).toContain("приватный");   // 127.0.0.1
    expect(reason("2002:a9fe:a9fe::")).toContain("приватный");   // 169.254.169.254
    expect(reason("2002:5db8:d822::")).toBeNull();               // 93.184.216.34
  });

  test("NAT64 well-known с приватным хвостом закрыт", () => {
    expect(reason("64:ff9b::7f00:1")).toContain("приватный");     // 127.0.0.1
    expect(reason("64:ff9b::a9fe:a9fe")).toContain("приватный");  // 169.254.169.254
    expect(reason("64:ff9b::5db8:d822")).toBeNull();              // 93.184.216.34
  });

  test("local-use NAT64 (64:ff9b:1::/48) закрыт целиком", () => {
    expect(reason("64:ff9b:1::1")).toContain("приватный");
  });

  test("Teredo и остальное из 2001::/23 закрыто", () => {
    expect(reason("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toContain("приватный");
    expect(reason("2001:1ff::1")).toContain("приватный");
    // Документационный 2001:db8::/32 в /23 не входит и режимом не затронут.
    expect(reason("2001:db8::10")).toBeNull();
  });

  test("site-local и discard-only закрыты", () => {
    expect(reason("fec0::1")).toContain("приватный");
    expect(reason("100::1")).toContain("приватный");
    // 100:1:: уже вне /64 — обычный юникаст.
    expect(reason("100:1::1")).toBeNull();
  });

  test("прежние префиксы по-прежнему закрыты, публичный — открыт", () => {
    for (const a of ["::1", "::", "::ffff:127.0.0.1", "fd00::1", "fe80::1", "ff02::1"]) {
      expect(reason(a)).toContain("приватный");
    }
    expect(reason("2606:4700:4700::1111")).toBeNull();
  });
});

describe("тот же фильтр применяется к ответу DNS", () => {
  test("AAAA с 6to4-обёрткой приватного адреса отбивается", async () => {
    const resolve = async () => [{ address: "2002:c0a8:0101::" }];
    const r = await blockedFetchReasonAsync("https://tunnel.example.test/x", resolve);
    expect(r).toContain("2002:c0a8:101::");
    expect(r).toContain("приватный");
  });
});
