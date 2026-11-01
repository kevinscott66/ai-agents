/** Filesystem boundary for editorial intake, human overlays and automatic output. */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { withJournalEditorial, type Kind, type RawRecord, type EditorialFile } from "./site-editorial-state.ts";

export const SITE_DIR = process.env.DELABS_SITE_DIR ?? "/opt/delabs";

/**
 * Где на самом деле лежит дерево сайта.
 *
 * До 20.09.2026 `/opt/delabs` и было деревом. С переходом на релизы (AUD-021)
 * там лежат `releases/<метка>/`, а рабочая копия — за ссылкой `current`, и
 * `/opt/delabs/src` перестал существовать. Редактура этого не заметила: чтение
 * корпуса падало молча, `readJson` возвращал пустой массив, и прогон бодро
 * сообщал «без редактуры никого». Сутки все новые выпуски выходили на сайт
 * текстом поста — ошибки при этом не было ни одной.
 *
 * Поэтому раскладка определяется, а не предполагается, и обе поддерживаются:
 * переменная `DELABS_SITE_DIR` может указывать и на рабочую копию на Mac, где
 * никакого `current` нет.
 */
export function siteTree(root: string = SITE_DIR): string {
  return existsSync(join(root, "current", "src", "data")) ? join(root, "current") : root;
}

/**
 * Корпус читается строго: пустой список от отсутствующего файла неотличим от
 * «всё уже отредактировано», и именно это скрыло поломку выше. Лучше падение
 * юнита, которое видно в `systemctl --failed`, чем спокойный отчёт ни о чём.
 */
export function readCorpus<T>(path: string): T[] {
  if (!existsSync(path)) {
    throw new Error(
      `нет корпуса ${path} — проверь раскладку сайта (releases/current) и DELABS_SITE_DIR`,
    );
  }
  const rows = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(rows)) throw new Error(`Invalid editorial corpus: ${path}`);
  return rows as T[];
}

/** Read both private queues before any research/write; missing intake fails closed. */
export function readEditorialCandidates(tree: string): Record<Kind, RawRecord[]> {
  const rows = {
    digests: readCorpus(join(tree, "src/data/current/editorial-candidates.json")),
    activities: readCorpus(join(tree, "src/data/current/activity-candidates.json")),
  } as Record<Kind, RawRecord[]>;
  if (rows.activities.some(row => typeof row.activityReviewRequired !== "boolean")) {
    throw new Error("Activity candidate queue lacks publication-review state; rebuild site intake first");
  }
  return rows;
}
export const AUTO_PATH =
  process.env.DELABS_EDITORIAL_AUTO ?? "/var/lib/delabs-editorial/editorial.json";

/** Read the optional snapshot and required live journal in their original order. */
export function readManualEditorial(tree: string): EditorialFile {
  return withJournalEditorial(readJson<EditorialFile>(join(tree, "src/data/snapshot/editorial.json"), {}),
    JSON.parse(readFileSync(join(tree, "src/data/edits.json"), "utf8")));
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * Запись через временный файл и rename: корпус пересобирается по таймеру
 * дважды в час и может прийти ровно в момент записи. rename в пределах одного
 * каталога атомарен — читатель увидит либо прежний файл, либо новый целиком.
 */
export function writeAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
}

