/**
 * Заглушка предеплойного смоука для песочниц, гоняющих deploy/deploy.sh.
 *
 * Круг 49 (tests/audit-2026-09-11-predeploy-smoke-unwired.test.ts): deploy.sh
 * снова зовёт `.github/scripts/pre-deploy-smoke.sh` и без него не начинает
 * выкатку вовсе. Настоящий скрипт делает `bun install` и полный прогон тестов
 * — в песочнице нужен не он, а факт вызова и послушание коду возврата.
 *
 * Живёт отдельным файлом намеренно: песочниц с deploy.sh две, и это ровно то
 * место, где копия правила разъезжается молча — третья песочница просто упала
 * бы с «нет pre-deploy-smoke.sh», и её автор дописал бы свою заглушку.
 *
 * В лог вызовов пишет строку `smoke <аргументы>`; код возврата берёт из
 * `SMOKE_RC` (по умолчанию 0), чтобы тест мог проверить и провал.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeSmokeStub(repoDir: string, callsFile: string): string {
  const dir = join(repoDir, ".github", "scripts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "pre-deploy-smoke.sh");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf 'smoke %s\\n' "$*" >> ${JSON.stringify(callsFile)}\nexit "\${SMOKE_RC:-0}"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}
