# Local video workflow for the team

The canonical role integration is `agent/characters/local-video.ts`, included in six built-in character prompts. Lead executes local work through the existing orchestrator-only `MAC_RUN_CLAUDE` bridge. No tool schemas, daemon commands, allowlists or role permissions are expanded.

| Role | Responsibility |
|---|---|
| design | Storyboard, framing, branding, typography, edit and visual identity |
| frontend | Custom Remotion/React motion composition when needed |
| smm | Distribution format, hook, CTA, safe zones; no automatic publishing |
| copy | Timed script, captions, transcript correction |
| qa | Real video/audio and visual verification |
| orchestrator | Collect scoped contributions, execute on Mac, report actual artifacts |

PM, Product, Backend, TG Dev, AI Eng and Permissions retain their existing scopes. An already delegated specialist returns the work to Lead without reverse delegation. A directly addressed specialist can hand the execution request to Lead.

## Local prerequisites and materials

Tool root on the owner's Mac: `/Users/dobropalm/programs/local-video-studio`.
Runtime instructions: `skills/local-video-edit/SKILL.md`; CLI/schema: `docs/architecture.md` in that root. Read those rather than maintaining another copy of the editing implementation here. The root must be admitted by the existing Mac project allowlist; the caller must satisfy the existing owner/approval checks. Use `bin/video doctor` before execution. A prompt does not establish an active bridge connection.

The installed stack is FFmpeg/ffprobe, Whisper with local small model, and Remotion. Hyperframes is not a dependency. Init creates `media/`, `assets/logos/`, `assets/fonts/`, `assets/music/`, `transcripts/`, `exports/`, `brief.md`, and `timeline.json`. Assets must actually be supplied; folder presence is not proof that they exist. Import handles video; photo compositions use Remotion as described by the local skill.

## Acceptance and release

A finished task returns an existing versioned MP4 and actual validation results, never an invented download URL. Local output needs a supported delivery channel before it can be treated as a remote attachment. Offline work does not authorize cloud generation or publication.

The source change needs normal PR/release handling before already running server agents receive it. Existing runtime prompt overrides can replace built-in prompts: inspect the active configuration read-only during release and report any override rather than changing the live DB. No release is implied by editing these files.
