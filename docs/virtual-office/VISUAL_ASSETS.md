# Visual assets — 2026-09-23

The five user references establish a realistic office direction: human proportions and clothing, fabric cubicles, wood floors, daylight, dark structural elements, believable chairs/monitors, and close character interaction. Reference images are not redistributed as product assets. The current increment implements twelve role avatars plus one controllable player; it does not claim the references' final photorealistic quality.

## Appearance presets

The Characters menu selects complete looks independently for the player and Backend, with hair/clothes/footwear descriptions. Validated preferences persist in localStorage. The default player wears a light shirt; Backend uses the young adult red long-sleeve look. A look does not change agent identity, role, task, permission or gateway state.

| Preset | Source model | Appearance |
| --- | --- | --- |
| suit | Business_Male_01 | Side-parted dark hair, black suit/red tie, leather shoes |
| shirt | Business_Male_06 | Short dark haircut, light shirt/dark trousers, thicker-soled shoes |
| bob | Business_Female_02 | Blonde bob/glasses, burgundy jacket/trousers, closed black shoes |
| skirt | Business_Female_03 | Dark layered haircut, taupe jacket/skirt, heeled shoes |

All models and motion clips are Microsoft Rocketbox, MIT. The original bald `backend.glb` remains as a legacy baseline, outside the current selector. These are complete authored appearance presets, not an editor that independently swaps garments, shoes or hair meshes. Exact source URLs, checksums, transformations, triangle counts, sizes and license paths are maintained in [asset manifest](../../virtual-office/assets/manifest.json).

Each model has idle breathing, seated breathing, walk, sit-down and stand-up clips. Female models use the female motion set; male models use the male set. Body/finger rotation tracks and root vertical motion are retained; controller navigation owns X/Z. Independent skeleton clones share immutable model geometry/materials. Bounded arm CCD targets index fingertips against shared keyboard anchors; gaze tracks proximity. No facial animation, foot IK or final production typing animation.

## Office and conversion

The furniture/monitor/paper graphics are original code; monitors explicitly label mock content. Poly Haven wood/fabric/wall maps are CC0 and served locally. Daylight/fill lighting uses one shadow light in balanced mode. The close interaction camera hides the floating label and swivels the chair with the seated character. Cubicle footprints participate in collision.

`tools/fetch-assets.py` fetches checksum-verified sources into ignored `.runtime/source-assets/`. `tools/build-variants.mjs` converts the four current presets using an isolated Chrome page and the shared browser converter. The dev server must be running. `tools/build-character.mjs` rebuilds the legacy model. Source files are development-only and never fetched by the shipped app.

The converter preserves original material slots and alpha channels. Opaque skin/clothing/normal maps export at up to 1024 JPEG; hair/glasses color-alpha maps use up to 512 PNG with double-sided alpha masking. A second alpha map is not multiplied into the already embedded alpha. TGA DataTextures are first converted to canvas-backed textures: Three r175's DataTexture exporter uses `putImageData`, which ignores scaling/flip transforms and previously cropped the atlas. The canvas path preserves the full atlas and orientation.

## Loading and performance

Safe startup remains 2D, with no scene/model/material downloads. Enabling 3D fetches twelve role models plus the selected player; legacy optional presets load when selected. The catalog budget and initial selected-model budget are separate in the manifest. Full-roster entry is bounded at 48 MB; the catalog including legacy presets is bounded at 65 MB. Tests check per-model/catalog/default-entry budgets, hashes, licenses, embedded images/buffers, alpha materials and all clip names.

30 FPS cap, hidden-tab pause, adaptive DPR, economy without shadows and complete WebGL unmount in 2D remain. Hosting a WebGL app does not move rendering to a remote server. Per-model caching is bounded by the four-preset catalog; full-roster loading/LOD remains future work.

A short Chrome 153 headless probe at viewport 1440×1000 with the default two distinct models measured approximately 30 rendered FPS in both modes. Balanced: CPU submission p95 4.0 ms, resolution 1440×839. Economy: p95 2.2 ms, 1080×629. Main-pass counters: 375 draw calls / 97,986 triangles. No page errors. This sample is about 6 seconds per mode and does not measure GPU completion, energy, total frame latency or a full roster. Raw output/screenshots remain in ignored `.runtime/`.

## Verification

Production build/typecheck and 14 Bun tests (524 assertions) passed. Browser coverage includes proximity/chat/task, mobile layout, reconnect, character idle walk/return, asset-free safe entry, and switching all four appearances independently on both actors, persistence after reload, lazy asset requests and no gateway events from look changes. Each preset was visually inspected in a close-up; the mobile menu was checked at 390×844. Run the browser suite and profiler sequentially: both mutate the shared mock scenario; an overlapping run interrupted the idle walk and required a sequential rerun.

Remaining work: live role integration, modular wardrobe if requested, facial animation, finer hands/foot planting, richer environment/final lighting, full-roster performance and owner-authenticated live backend. No public deployment in this increment.

## Twelve-person Russian team increment

`web/src/roster.ts` owns twelve unique role/name/model/seat assignments. This is a fictional young adult team from Russia, visually aimed at approximately 18–24; the stock assets do not establish a real person's nationality or exact age. Six male and six female everyday looks replace business attire as the roster defaults. Hair, clothes and footwear are authored together. `assets/roster-sources.json` records the selected Adult models; `tools/build-roster.mjs` exports them at 512px texture resolution. The older four appearances remain selectable for player/Backend.

The office is 20×20 metres with three columns and four rows. Role selection opens a close camera and read-only card. Only Backend has a mock runtime; eleven other seats explicitly say unconnected, with no fabricated tasks. Keyboard keys use instancing. The Backend seat is closer to the centred keyboard; finger targets use actual world coordinates and correct left/right sides. Only a fully seated occupant turns their chair; an empty chair retains its last angle.

A short Chrome 153 probe with the full roster at 1440×1000 measured about 30 FPS in economy mode, 646 draw calls, 193878 visible triangles and CPU submission p95 5.3 ms (balanced 7.4 ms). This is a bounded local probe, not a ten-minute soak or target-device GPU guarantee.
