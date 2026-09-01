/**
 * Аудит 2026-09-01: воркфлоу, которые пишут в main, остались без учётных
 * данных.
 *
 * В `watchdog.yml`, `monitor.yml` и `unblock-stale.yml` появился
 * `persist-credentials: false` у `actions/checkout`. Флаг делает ровно то, что
 * обещает: удаляет `http.extraheader` с токеном из `.git/config` после
 * клонирования. Но у всех трёх последний шаг — `git pull --rebase origin main`
 * и `git push origin HEAD:main`. Без extraheader обе команды идут к origin
 * анонимно: push отвергается всегда, а на приватном репозитории не проходит и
 * fetch. То есть дайджест собирается, коммит создаётся и молча никуда не
 * уезжает — джоба краснеет на последнем шаге либо (при `|| true` выше по
 * цепочке) отчитывается успехом, ничего не опубликовав.
 *
 * `persist-credentials: false` уместен там, где после checkout исполняется
 * недоверенный код (сборка PR, сторонние actions). Для джобы, которая сама
 * пишет в main и не запускает ничего кроме `gh`, `jq` и `git`, снятие токена
 * не добавляет защиты, а отнимает функцию.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const PUSHING = ["watchdog.yml", "monitor.yml", "unblock-stale.yml"];

describe("воркфлоу, пишущие в main, сохраняют учётку checkout", () => {
  for (const name of PUSHING) {
    const src = readFileSync(join(ROOT, ".github", "workflows", name), "utf8");

    test(`${name} действительно пушит в main`, () => {
      expect(src).toContain("git push origin HEAD:main");
    });

    test(`${name} не снимает креды у checkout`, () => {
      const active = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"))
        .join("\n");
      expect(active).not.toContain("persist-credentials: false");
    });
  }
});
