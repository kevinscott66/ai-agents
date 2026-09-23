import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../assets/manifest.json";
import {
  CHARACTERS,
  DEFAULT_APPEARANCE,
  characterUrl,
} from "../web/src/characters";
const publicRoot = resolve(import.meta.dir, "../web/public");
test("licensed appearance assets are intact, self-contained and within download budgets", () => {
  let total = 0;
  for (const asset of manifest.assets) {
    const bytes = readFileSync(resolve(publicRoot, "." + asset.path));
    expect(bytes.length).toBe(asset.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
    expect(
      readFileSync(resolve(publicRoot, "." + asset.licensePath)).length,
    ).toBeGreaterThan(100);
    total += bytes.length;
    if (!asset.path.endsWith(".glb")) continue;
    expect(bytes.length).toBeLessThan(manifest.budgets.perCharacterBytes);
    expect(bytes.toString("ascii", 0, 4)).toBe("glTF");
    const document = JSON.parse(
      bytes.toString("utf8", 20, 20 + bytes.readUInt32LE(12)),
    );
    expect(
      document.animations.map((a: { name: string }) => a.name).sort(),
    ).toEqual(["idle", "seated", "sitdown", "standup", "walk"]);
    expect(document.skins.length).toBeGreaterThan(0);
    expect(document.images.length).toBeGreaterThanOrEqual(4);
    for (const image of document.images) {
      expect(image.uri).toBeUndefined();
      expect(image.bufferView).toBeNumber();
      expect(["image/jpeg", "image/png"]).toContain(image.mimeType);
    }
    for (const buffer of document.buffers) expect(buffer.uri).toBeUndefined();
    if (["suit", "bob", "skirt"].includes(asset.id)) {
      expect(
        document.materials.some(
          (m: { alphaMode?: string }) => m.alphaMode === "MASK",
        ),
      ).toBe(true);
      expect(
        document.images.some(
          (i: { mimeType: string }) => i.mimeType === "image/png",
        ),
      ).toBe(true);
    }
  }
  expect(total).toBeLessThan(manifest.budgets.catalogBytes);
  const initial = new Set([
    characterUrl(DEFAULT_APPEARANCE.player),
    characterUrl(DEFAULT_APPEARANCE.backend),
  ]);
  const initialBytes = manifest.assets
    .filter((a) => initial.has(a.path) || a.path.includes("/materials/"))
    .reduce((sum, a) => sum + a.bytes, 0);
  expect(initialBytes).toBeLessThan(
    manifest.budgets.initial3DModelAndTextureBytes,
  );
  for (const preset of CHARACTERS)
    expect(
      manifest.assets.some((a) => a.path === characterUrl(preset.id)),
    ).toBe(true);
});
