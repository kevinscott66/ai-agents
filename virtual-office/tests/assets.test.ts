import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import manifest from "../assets/manifest.json";

const publicRoot = resolve(import.meta.dir, "../web/public");
test("licensed assets are self-contained, intact and within the one-character download budget", () => {
  let total = 0;
  for (const asset of manifest.assets) {
    const bytes = readFileSync(resolve(publicRoot, "." + asset.path));
    expect(bytes.length).toBe(asset.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
    expect(
      readFileSync(resolve(publicRoot, "." + asset.licensePath)).length,
    ).toBeGreaterThan(100);
    total += bytes.length;
  }
  expect(total).toBeLessThan(8_000_000);
  const glb = readFileSync(
    resolve(publicRoot, "assets/characters/backend.glb"),
  );
  expect(glb.length).toBeLessThan(4_000_000);
  expect(glb.toString("ascii", 0, 4)).toBe("glTF");
  const document = JSON.parse(
    glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)),
  );
  expect(
    document.animations.map((a: { name: string }) => a.name).sort(),
  ).toEqual(["idle", "seated", "sitdown", "standup", "walk"]);
  expect(document.skins.length).toBeGreaterThan(0);
  expect(document.images).toHaveLength(4);
  for (const image of document.images) {
    expect(image.uri).toBeUndefined();
    expect(image.bufferView).toBeNumber();
    expect(image.mimeType).toBe("image/jpeg");
  }
  for (const buffer of document.buffers) expect(buffer.uri).toBeUndefined();
});
