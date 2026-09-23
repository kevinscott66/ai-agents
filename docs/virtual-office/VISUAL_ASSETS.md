# Visual assets — 2026-09-23

The five user references establish a realistic office direction: human proportions and clothing, fabric cubicles, wood floors, daylight, dark structural elements, believable chairs/monitors, and close character interaction. Reference images are not redistributed as product assets. The current increment implements selectable appearances for one NPC and one player; it does not claim the references' final photorealistic quality.

## Appearance presets

The «Персонажи» menu selects complete looks independently for the player and Backend, with hair/clothes/footwear descriptions. Validated preferences persist in localStorage. The default player wears a light shirt; Backend uses the female bob/jacket look. A look does not change agent identity, role, task, permission or gateway state.

| Preset | Source model | Appearance |
| --- | --- | --- |
| suit | Business_Male_01 | Side-parted dark hair, black suit/red tie, leather shoes |
| shirt | Business_Male_06 | Short dark haircut, light shirt/dark trousers, thicker-soled shoes |
| bob | Business_Female_02 | Blonde bob/glasses, burgundy jacket/trousers, closed black shoes |
| skirt | Business_Female_03 | Dark layered haircut, taupe jacket/skirt, heeled shoes |

All models and motion clips are Microsoft Rocketbox, MIT. The original bald `backend.glb` remains as a legacy baseline, outside the current selector. These are complete authored appearance presets, not an editor that independently swaps garments, shoes or hair meshes. Exact source URLs, checksums, transformations, triangle counts, sizes and license paths are maintained in [asset manifest](../../virtual-office/assets/manifest.json).

Each model has idle breathing, seated breathing, walk, sit-down and stand-up clips. Female models use the female motion set; male models use the male set. Body/finger rotation tracks and root vertical motion are retained; controller navigation owns X/Z. Independent skeleton clones share immutable model geometry/materials. Bounded arm CCD places wrists near the keyboard; gaze tracks proximity. No facial animation, foot IK or final production typing animation.

## Office and conversion

The furniture/monitor/paper graphics are original code; monitors explicitly label mock content. Poly Haven wood/fabric/wall maps are CC0 and served locally. Daylight/fill lighting uses one shadow light in balanced mode. The close interaction camera hides the floating label and swivels the chair with the seated character. Cubicle footprints participate in collision.

`tools/fetch-assets.py` fetches checksum-verified sources into ignored `.runtime/source-assets/`. `tools/build-variants.mjs` converts the four current presets using an isolated Chrome page and the shared browser converter. The dev server must be running. `tools/build-character.mjs` rebuilds the legacy model. Source files are development-only and never fetched by the shipped app.

The converter preserves original material slots and alpha channels. Opaque skin/clothing/normal maps export at up to 1024 JPEG; hair/glasses color-alpha maps use up to 512 PNG with double-sided alpha masking. A second alpha map is not multiplied into the already embedded alpha. TGA DataTextures are first converted to canvas-backed textures: Three r175's DataTexture exporter uses `putImageData`, which ignores scaling/flip transforms and previously cropped the atlas. The canvas path preserves the full atlas and orientation.

## Loading and performance

Safe startup remains 2D, with no scene/model/material downloads. Enabling 3D fetches the two selected models; other presets load only when chosen and then remain cached. The catalog budget and initial selected-model budget are separate in the manifest. Current defaults plus environment maps transfer about 11 MB, versus about 21 MB for the entire delivered catalog including the legacy asset. Tests check per-model/catalog/default-entry budgets, hashes, licenses, embedded images/buffers, alpha materials and all clip names.

30 FPS cap, hidden-tab pause, adaptive DPR, economy without shadows and complete WebGL unmount in 2D remain. Hosting a WebGL app does not move rendering to a remote server. Per-model caching is bounded by the four-preset catalog; full-roster loading/LOD remains future work.

A short Chrome 153 headless probe at viewport 1440×1000 with the default two distinct models measured approximately 30 rendered FPS in both modes. Balanced: CPU submission p95 4.0 ms, resolution 1440×839. Economy: p95 2.2 ms, 1080×629. Main-pass counters: 375 draw calls / 97,986 triangles. No page errors. This sample is about 6 seconds per mode and does not measure GPU completion, energy, total frame latency or a full roster. Raw output/screenshots remain in ignored `.runtime/`.

## Verification

Production build/typecheck and 14 Bun tests (227 assertions) passed. Browser coverage includes proximity/chat/task, mobile layout, reconnect, female-character idle walk/return, asset-free safe entry, and switching all four appearances independently on both actors, persistence after reload, lazy asset requests and no gateway events from look changes. Each preset was visually inspected in a close-up; the mobile menu was checked at 390×844. Run the browser suite and profiler sequentially: both mutate the shared mock scenario; an overlapping run interrupted the idle walk and required a sequential rerun.

Remaining work: per-role assignment across the real roster, modular wardrobe if requested, facial animation, finer hands/foot planting, richer environment/final lighting, full-roster performance and owner-authenticated live backend. No public deployment in this increment.
