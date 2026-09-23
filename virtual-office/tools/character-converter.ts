import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { TGALoader } from "three/examples/jsm/loaders/TGALoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
export async function loadSource(base: string, animationBase = base) {
  const manager = new THREE.LoadingManager();
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  manager.setURLModifier((url) => {
    const file = url.split(/[\\/]/).at(-1)!;
    return file.toLowerCase().endsWith(".tga")
      ? base + file.toLowerCase()
      : url;
  });
  const loader = new FBXLoader(manager);
  const texturesReady = new Promise<void>((resolve) => {
    manager.onLoad = () => resolve();
  });
  const model = await loader.loadAsync(base + "character.fbx");
  await texturesReady;
  const idle = await loader.loadAsync(animationBase + "idle.fbx");
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
            alpha: (m as THREE.MeshPhongMaterial).alphaMap?.name,
            normal: (m as THREE.MeshPhongMaterial).normalMap?.name,
            transparent: m.transparent,
            opacity: m.opacity,
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
export async function convert(
  base: string,
  animationBase = base,
  textureSize = 1024,
) {
  const { model, loader, summary } = await loadSource(base, animationBase);
  const sources = await Promise.all(
    ["idle", "seated", "walk", "sitdown", "standup"].map(async (name) => ({
      name,
      object: await loader.loadAsync(animationBase + name + ".fbx"),
    })),
  );
  // Preserve source material slots, including hair cards and glasses.
  const replacements = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const toCanvasTexture = (source: THREE.Texture, opacity = false) => {
    const dataTexture = source as THREE.DataTexture;
    const pixels = new Uint8ClampedArray(
      new Uint8Array(
        dataTexture.image.data.buffer,
        dataTexture.image.data.byteOffset,
        dataTexture.image.data.byteLength,
      ),
    );
    const canvas = document.createElement("canvas");
    canvas.width = dataTexture.image.width;
    canvas.height = dataTexture.image.height;
    canvas
      .getContext("2d")!
      .putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
    // Canvas-backed textures preserve full atlas scaling and vertical orientation.
    let exported = canvas;
    if (opacity) {
      exported = document.createElement("canvas");
      exported.width = Math.min(512, canvas.width);
      exported.height = Math.min(512, canvas.height);
      exported
        .getContext("2d")!
        .drawImage(canvas, 0, 0, exported.width, exported.height);
    }
    const texture = new THREE.CanvasTexture(exported);
    texture.flipY = source.flipY;
    texture.userData.mimeType = opacity ? "image/png" : "image/jpeg";
    return texture;
  };
  const convertMaterial = (material: THREE.Material) => {
    if (replacements.has(material)) return replacements.get(material)!;
    const source = material as THREE.MeshPhongMaterial;
    const masked = source.transparent || !!source.alphaMap;
    const map = source.map ? toCanvasTexture(source.map, masked) : null;
    if (map) map.colorSpace = THREE.SRGBColorSpace;
    const normalMap = source.normalMap
      ? toCanvasTexture(source.normalMap)
      : null;
    // Rocketbox opacity-color TGA stores transparency in its alpha channel.
    // Export it in baseColor PNG; a second alphaMap would multiply color into alpha.
    const converted = new THREE.MeshStandardMaterial({
      name: source.name,
      map,
      normalMap,
      color: map ? 0xffffff : source.color,
      roughness: source.name.includes("head") ? 0.72 : 0.9,
      metalness: 0,
      normalScale: new THREE.Vector2(0.55, 0.55),
      alphaTest: masked ? 0.35 : 0,
      side: masked ? THREE.DoubleSide : THREE.FrontSide,
    });
    replacements.set(material, converted);
    return converted;
  };
  model.traverse((o) => {
    o.userData = {};
    if (o instanceof THREE.Mesh) {
      o.material = Array.isArray(o.material)
        ? o.material.map(convertMaterial)
        : convertMaterial(o.material);
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
    maxTextureSize: textureSize,
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
