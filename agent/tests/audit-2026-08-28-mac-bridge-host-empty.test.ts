/**
 * Аудит 2026-08-28: пустой MAC_BRIDGE_HOST снимал мост с loopback.
 *
 * Было `process.env.MAC_BRIDGE_HOST ?? "127.0.0.1"`. `??` ловит только
 * отсутствие имени, а systemd для строки `KEY=` отдаёт пустую строку — и
 * `.env.example` отгружает переменную ровно так, с инструкцией «Copy to
 * .env». То есть пустая строка тут не экзотика, а поставляемый дефолт.
 *
 * Замер на рантайме проекта (`lsof` по своему PID): `hostname: ""` поднимает
 * сокет на `*:PORT` — IPv6-wildcard, все интерфейсы, — тогда как
 * `"127.0.0.1"` даёт `127.0.0.1:PORT`. При этом `server.hostname` для пустой
 * строки возвращает `"localhost"`, поэтому по логу подмена не видна.
 *
 * Цена: комментарий у вызова обещает loopback именно потому, что шифрование
 * даёт ssh-туннель, а не мост. На wildcard тот же мост слушает публичный
 * интерфейс по нешифрованному `ws://`, а за ним — запуск `claude` на машине
 * владельца.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { _resolveBridgeHost } from "../lib/mac-bridge.ts";
import { DEFAULT_MAC_BRIDGE_HOST } from "../lib/constants.ts";

describe("предпосылки", () => {
  test("пустая строка проходит сквозь ?? и останавливается на ||", () => {
    const raw: string | undefined = "";
    expect(raw ?? DEFAULT_MAC_BRIDGE_HOST).toBe("");
    expect(raw || DEFAULT_MAC_BRIDGE_HOST).toBe("127.0.0.1");
  });

  test(".env.example отгружает переменную пустой", () => {
    const env = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const line = env.split("\n").find((l) => l.startsWith("MAC_BRIDGE_HOST"));
    expect(line).toBeDefined();
    expect(/^MAC_BRIDGE_HOST=\s*(#|$)/.test(String(line))).toBe(true);
  });

  test("Bun различает пустую строку и loopback при привязке", () => {
    // Наблюдаемое различие без сети: у loopback-сокета семейство IPv4 и адрес
    // 127.0.0.1, у пустой строки — IPv6-wildcard `::`. Само `server.hostname`
    // врёт («localhost»), поэтому смотрим на то, что вернула ОС.
    const empty = Bun.serve({ port: 0, hostname: "", fetch: () => new Response("ok") });
    const loop = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      expect(loop.url.hostname).toBe("127.0.0.1");
      expect(empty.url.hostname).not.toBe("127.0.0.1");
    } finally {
      empty.stop(true);
      loop.stop(true);
    }
  });
});

describe("_resolveBridgeHost", () => {
  test("пусто, пробелы и отсутствие — loopback", () => {
    for (const raw of ["", "   ", "\t", undefined]) {
      expect(_resolveBridgeHost(raw)).toBe("127.0.0.1");
    }
  });

  test("осознанно заданный интерфейс проходит", () => {
    expect(_resolveBridgeHost("0.0.0.0")).toBe("0.0.0.0");
    expect(_resolveBridgeHost("::1")).toBe("::1");
    expect(_resolveBridgeHost("10.0.0.5")).toBe("10.0.0.5");
  });

  test("окружение приходит с пробелами по краям — они срезаются", () => {
    expect(_resolveBridgeHost(" 0.0.0.0 ")).toBe("0.0.0.0");
  });
});

describe("применение", () => {
  const SRC = readFileSync(new URL("../lib/mac-bridge.ts", import.meta.url), "utf8");

  test("старт моста берёт хост через санитайзер", () => {
    expect(SRC).toContain("_resolveBridgeHost(process.env.MAC_BRIDGE_HOST)");
  });

  test("голого `??` на этой переменной больше нет нигде", () => {
    // Комментарии снимаем построчно: докблок санитайзера цитирует прежнюю
    // форму дословно, и без фильтра сторож ловил бы собственное объяснение.
    const hits = SRC.split("\n")
      .filter((l) => {
        const t = l.trimStart();
        return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
      })
      .filter((l) => /process\.env\.MAC_BRIDGE_HOST\s*\?\?/.test(l));
    expect(hits).toEqual([]);
  });

  test("дефолт живёт в константе, а не литералом у вызова", () => {
    expect(DEFAULT_MAC_BRIDGE_HOST).toBe("127.0.0.1");
    expect(SRC).toContain("DEFAULT_MAC_BRIDGE_HOST");
  });
});
