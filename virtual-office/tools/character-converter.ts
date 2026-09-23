import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
export async function loadSource(base: string) {
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  manager.setURLModifier((url) => {
    const file = url.split(/[\\/]/).at(-1)!;
    return file.toLowerCase().endsWith(".tga")
      ? base + file.toLowerCase()
      : url;
  });
  const loader = new FBXLoader(manager);
  const model = await loader.loadAsync(base + "character.fbx");
  const idle = await loader.loadAsync(base + "idle.fbx");
  const meshes: unknown[] = [],
    bones: unknown[] = [];
  model.updateMatrixWorld(true);
  model.traverse((o) => {
    if (o instanceof THREE.Mesh)
      meshes.push({
        name: o.name,
        vertices: o.geometry.attributes.position.count,
        materials: (Array.isArray(o.material) ? o.material : [o.material]).map(
          (m) => ({
            name: m.name,
            type: m.type,
            map: (m as THREE.MeshPhongMaterial).map?.name,
          }),
        ),
      });
    if (o instanceof THREE.Bone)
      bones.push({
        name: o.name,
        pos: o.position.toArray(),
        world: o.getWorldPosition(new THREE.Vector3()).toArray(),
        q: o.quaternion.toArray(),
      });
  });
  return {
    model,
    loader,
    summary: {
      meshes,
      bones,
      bounds: new THREE.Box3()
        .setFromObject(model)
        .getSize(new THREE.Vector3())
        .toArray(),
      idleClips: idle.animations.map((c) => ({
        name: c.name,
        duration: c.duration,
        tracks: c.tracks.slice(0, 8).map((t) => ({
          name: t.name,
          values: Array.from(t.values.slice(0, 8)),
        })),
      })),
    },
  };
}
export async function inspect(base: string) {
  return (await loadSource(base)).summary;
}
export async function convert(base: string) {
  const { model, loader, summary } = await loadSource(base);
  const sources = await Promise.all(
    ["idle", "seated", "walk", "sitdown", "standup"].map(async (name) => ({
      name,
      object: await loader.loadAsync(base + name + ".fbx"),
    })),
  );
  const texLoader = new TGALoader();
  const materials = await Promise.all(
    ["body", "head"].map(async (part) => {
      const [map, normalMap] = await Promise.all([
        texLoader.loadAsync(base + `m015_${part}_color.tga`),
        texLoader.loadAsync(base + `m015_${part}_normal.tga`),
      ]);
      // GLTFExporter r175 puts DataTexture pixels directly into the resized canvas:
      // putImageData ignores both resampling and flipY. Convert to a canvas-backed
      // Texture first so the exporter uses drawImage and preserves the full UV atlas.
      const canvasTexture = (source: THREE.DataTexture) => {
        const canvas = document.createElement("canvas");
        canvas.width = source.image.width;
        canvas.height = source.image.height;
        canvas
          .getContext("2d")!
          .putImageData(
            new ImageData(
              new Uint8ClampedArray(
                new Uint8Array(
                  source.image.data.buffer,
                  source.image.data.byteOffset,
                  source.image.data.byteLength,
                ),
              ),
              canvas.width,
              canvas.height,
            ),
            0,
            0,
          );
        const texture = new THREE.CanvasTexture(canvas);
        texture.flipY = source.flipY;
        return texture;
      };
      const color = canvasTexture(map),
        normal = canvasTexture(normalMap);
      color.colorSpace = THREE.SRGBColorSpace;
      color.userData.mimeType = "image/jpeg";
      normal.userData.mimeType = "image/jpeg";
      const m = new THREE.MeshStandardMaterial({
        name: `rocketbox_${part}`,
        map: color,
        normalMap: normal,
        roughness: part === "head" ? 0.72 : 0.9,
        metalness: 0,
        normalScale: new THREE.Vector2(0.55, 0.55),
      });
      return m;
    }),
  );
  model.traverse((o) => {
    o.userData = {};
    if (o instanceof THREE.Mesh) {
      o.material = materials;
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  const known = new Set<string>();
  model.traverse((o) => known.add(o.name));
  const clips = sources.map(({ name, object }) => {
    const tracks = object.animations[0].tracks
      .filter(
        (t) =>
          known.has(t.name.split(".")[0]) &&
          (t.name === "Bip01.position" ||
            (t.name.endsWith(".quaternion") &&
              /^Bip01(?:$|_(?:Pelvis|Spine\d*|Neck|Head|[LR]_(?:Clavicle|UpperArm|Forearm|Hand|Finger\d*|Thigh|Calf|Foot|Toe\d*)))$/.test(
                t.name.split(".")[0],
              ))),
      )
      .map((t) => t.clone());
    for (const track of tracks) {
      if (track.name === "Bip01.position") {
        // Locomotion controller owns X/Z. Keep authored height/breath/sit motion.
        for (let i = 0; i < track.values.length; i += 3) {
          track.values[i] = 0;
          track.values[i + 2] = 0;
        }
      }
    }
    return new THREE.AnimationClip(name, -1, tracks).optimize();
  });
  model.name = "OfficeCharacter";
  model.scale.setScalar(0.01);
  const exporter = new GLTFExporter();
  const buffer = (await exporter.parseAsync(model, {
    binary: true,
    maxTextureSize: 1024,
    animations: clips,
    onlyVisible: true,
  })) as ArrayBuffer;
  const bytes = new Uint8Array(buffer);
  let raw = "";
  for (let i = 0; i < bytes.length; i += 32768)
    raw += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return {
    base64: btoa(raw),
    summary: {
      ...summary,
      bytes: bytes.length,
      clips: clips.map((c) => ({
        name: c.name,
        duration: c.duration,
        tracks: c.tracks.length,
        root: c.tracks
          .find((t) => t.name === "Bip01.position")
          ?.values.slice(0, 3),
      })),
    },
  };
}
