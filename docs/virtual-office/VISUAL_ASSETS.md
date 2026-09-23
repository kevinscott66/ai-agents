# Visual asset spike — 2026-09-23

The five user references establish a realistic office direction: human proportions and clothing, fabric cubicles, wood floors, daylight, dark structural elements, believable chairs/monitors, and close character interaction. Reference images are not redistributed as product assets. This increment improves one NPC/workstation before roster scaling; it does not claim the references' final photorealistic quality.

## Delivered

- Microsoft Rocketbox `Business_Male_04`, MIT, fixed repository revision; 7,326 triangles. One shared model, independent cloned skeletons for NPC/player. Not a MetaHuman model and no MetaHuman branding.
- Five Rocketbox clips: idle breathing, seated breathing, walking, sit down and stand up. Retained 54 body/finger tracks per clip; world navigation controls X/Z, animation controls vertical posture. Limited arm CCD places wrists near the keyboard; small gaze rotation follows proximity. Animation never changes gateway state.
- Original rounded furniture, swivel chair, keyboard, dual screens, cubicle fabric, mug/papers/lamp, bookcase, plants and suspended ceiling. Static monitor graphics explicitly show MOCK, not fabricated live telemetry.
- Poly Haven 1K wood color/normal/roughness, fabric normal and wall normal, CC0. Local assets only, no runtime provider calls.
- Daylight/fill lighting; one shadow-casting light in balanced mode. Close camera during inspection; chair turns with the seated character and floating label hides in close-up. Updated cubicle collision footprints.

Exact upstream URLs, checksums, transformations and licenses are maintained only in [asset manifest](../../virtual-office/assets/manifest.json). Redistributed MIT notice and texture credit are under `virtual-office/web/public/licenses/`.

## Pipeline and budgets

`tools/fetch-assets.py` fetches and checksum-validates pinned source FBX/TGA into ignored `.runtime/source-assets/`. `tools/build-character.mjs` uses an isolated Chrome page and the browser converter to export GLB. It requires the local dev server. Sources are never imported by the shipped app.

The converter converts TGA DataTextures to canvas-backed textures before GLTF export. In Three r175, the DataTexture exporter path uses `putImageData`, which ignores rescaling/flip transforms and cropped a 2048 atlas to 1024. The canvas path uses `drawImage`, preserving the full atlas and orientation. This was caught in visual inspection and corrected before delivery.

GLB: 2,913,476 bytes with four embedded 1024 JPEG maps. All delivered model/texture assets: 6,387,338 bytes. Guardrails: GLB <4 MB, total assets <8 MB; automated checks verify hashes, embedded images/buffers, licenses and all five clip names. Source downloads are larger and development-only.

The app retains a 30 FPS cap, hidden-tab pause, adaptive resolution, economy mode without shadows, and 2D mode that unmounts WebGL. The economy DPR is controlled by the Canvas owner so renderer reconfiguration cannot reset it; a browser regression assertion verifies the 1080-pixel render width. These controls reduce local work; hosting a WebGL app does not move rendering to the server.

## Verification and limits

14 Bun tests (117 assertions), production build/typecheck, and all four Chrome interaction/network/ambient scenarios passed after the visual changes. The existing idle → walk → window → return test also verifies that ambient movement creates no productivity events. Screenshots were inspected at 1440×1000; mobile 2D remains usable.

A repeatable short probe is `node tools/profile-scene.mjs`; raw results/screenshots remain in ignored `.runtime/`. Two approximately 6-second Chrome 153 headless samples at a 1440×1000 viewport: balanced 185 frames/6.17 s (~30 FPS), CPU submission p95 3.1 ms, render resolution 1440×839; economy 184 frames/6.15 s (~30 FPS), p95 2.0 ms, resolution 1080×629. Main-pass counters: 382 draw calls, 97,048 triangles. No page errors; 2D unmount and re-entry verified. CPU submission includes simulation/renderer calls but does not measure GPU completion, total frame latency, energy or memory. This is one NPC plus player, not the complete roster or a target-hardware guarantee.

Remaining visual work: distinct identities/wardrobes, finer hands and typing motion, foot planting, facial animation, richer background architecture and final lighting. Some furniture/plants remain procedural. The model's age and low polygon count limit close-up fidelity. Full-roster instancing/LOD and ten-minute target-device profiling are required before claiming final performance. Live backend and public hosting/authentication remain separate increments.
