/**
 * Заглушка сторожа диска для песочниц, гоняющих deploy/deploy.sh.
 *
 * AUD-20260919-026: deploy.sh зовёт `deploy/disk-guard.sh --need` до смоука и
 * до замка и без этого файла выкатку не начинает вовсе — как и без смоука.
 * Настоящий сторож ходит по ssh за `df` на прод; песочнице нужен не он, а
 * факт вызова и послушание коду возврата.
 *
 * Живёт отдельным файлом по той же причине, что и deploy-smoke-stub.ts:
 * песочниц с deploy.sh уже пять, и это ровно то место, где копия правила
 * разъезжается молча — шестая просто упала бы с «нет disk-guard.sh», и её
 * автор дописал бы свою заглушку.
 *
 * В лог вызовов пишет строку `disk-guard <аргументы>`; код возврата берёт из
 * `DISK_GUARD_RC` (по умолчанию 0), чтобы тест мог проверить и предупреждение
 * (1, выкатка продолжается), и отказ (2, выкатка останавливается).
 *
 * Настоящий скрипт со всеми тремя состояниями проверяется отдельно —
 * tests/audit-2026-09-19-disk-headroom.test.ts, там df подменён на PATH.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeDiskGuardStub(repoDir: string, callsFile: string): string {
  const dir = join(repoDir, "deploy");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "disk-guard.sh");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf 'disk-guard %s\\n' "$*" >> ${JSON.stringify(callsFile)}\nexit "\${DISK_GUARD_RC:-0}"\n`,
  );
  chmodSync(path, 0o755);
  return path;
}
