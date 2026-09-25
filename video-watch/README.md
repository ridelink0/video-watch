# video-watch

A Claude Code / Codex plugin for "watching" a video file. An LLM can't read a
video directly, so `scripts/watch.mjs` turns it into a set of frame images
(plus optional contact sheets) that can be read like any other picture.

See `skills/watch-video/SKILL.md` for the guidance an agent loads when using
this - what to read first (sheets), when to zoom in, and how to handle sound.

## Requirements

- Node.js (no npm dependencies - the script only uses the Node standard library).
- `ffmpeg` and `ffprobe` on `PATH`, or discoverable via the common install
  locations the script checks (including a winget package install on
  Windows), or pointed at directly with the `FFMPEG_PATH` / `FFPROBE_PATH`
  environment variables.

## Usage

```
node scripts/watch.mjs <video> [options]
```

| flag | default | meaning |
|---|---|---|
| `--n N` | `24` | how many frames to extract. Capped to the number of distinct frames actually available in the selected range at the source fps - and when it caps, you get exactly that many distinct frames, not one short. |
| `--mode grid\|scene` | `grid` | `grid` samples evenly across the range. `scene` detects cuts (ffmpeg's `scene` filter) and keeps every one it finds, then fills the rest of `--n` with evenly spaced frames from the largest remaining gaps - so a slowly changing clip with only a couple of hard cuts still gets full coverage instead of two frames. When there are more cuts than `--n` has room for, one frame is spent on the run-in before the first cut (a cut is the first frame of the scene *after* it, so a sample of nothing but cuts never shows the opening scene). Falls back to `grid` (with a message) if fewer than 2 cuts are found. |
| `--tokens N` | `1568` | visual-token budget per image. Frames (and contact sheets) are written at the largest size, at the clip's own aspect ratio, that fits it without any model resizing them - see [Why these defaults](#why-these-defaults). A 16:9 clip comes out 1456x818 at ~1560 tokens. Above 1568 the edge limit becomes 2000px. |
| `--width N` | fit to `--tokens` | fix the long edge of the frame instead (not literally the pixel width - a portrait clip is sized on its height). Never upscales past the source's own long edge. With `--tokens` as well, the frame fits the budget inside that edge. Over 2000px it warns: the API rejects such an image in any request holding more than 20 images. |
| `--from T` / `--to T` | clip start / end | restrict extraction to a time range. Accepts plain seconds (`90`, `12.5`) or a clock value (`mm:ss` or `hh:mm:ss`, e.g. `1:30` = 90s). An explicit `0` is honored (not read as "unset"), and a value that is not a time at all is refused rather than replaced by a default. |
| `--threshold F` | `0.3` | scene-change sensitivity for `--mode scene` (ffmpeg's `scene` score, 0-1). An explicit `0` is honored. |
| `--sheet CxR` | off | also tile frames into contact sheets, `C` columns by `R` rows per sheet - read these first. Each whole sheet, margins included, is fitted to the same `--tokens` budget as a frame, so a 3x3 sheet is nine frames for the price of one. The last sheet drops the rows it has no frames for rather than paying for empty tiles. A spec with only one number (`--sheet 4`) sets the columns and leaves the rows at 3. |
| `--label` | off | burn the timestamp into the top-left corner of each frame. If ffmpeg can't parse the label filter for some reason, the script drops labels for the rest of the run and says why, rather than failing the whole extraction. |
| `--out DIR` | OS temp dir, under `video-watch/<slug>` | where frames are written. Refuses to touch a non-empty directory unless `--force` is given (an earlier version of this script wiped a project folder this way). Also refuses cleanly if `--out` points at an existing file. |
| `--force` | off | allow `--out` to overwrite a non-empty directory. |
| `--json` | off | print the manifest as JSON instead of the human-readable summary. |
| `--dry-run` | off | probe the file, pick the timestamps and print the plan (binaries found, duration, fps, rotation, mode, every timestamp, the ffmpeg argv for the first frame) without creating `--out` or spawning a single frame extraction. With `--json` the plan is JSON. |

The manifest (in both `--json` and plain-text form) always states what the run
actually did: which mode was used (including a fallback from `scene` to
`grid`), how many frames came from real scene cuts versus top-up fill, the
clip's coded size versus its display size when the source carries a rotation
tag, the size every frame was written at with its token cost (`frameSize`,
`tokensPerFrame`, and `size`/`tokens` per sheet), and the path/timestamp of every
frame it wrote. A frame that had to be re-encoded coarser to stay under Claude
Code's Read byte budget carries its `q`.

### Rotation

Phone and phone-screen recordings are commonly stored landscape with a
rotation tag telling the player to turn them for display (a portrait clip
whose *coded* frame is landscape). The script reads that rotation - from a
plain `rotate` stream tag or a `Display Matrix` side-data entry, whichever
the source carries - and uses the resulting *display* dimensions (not the
coded ones) to decide orientation, choose the scale target, and rotate the
extracted frame so it comes out upright at the right size.

## Why these defaults

Checked against Anthropic's vision docs on 2026-09-25
([Vision](https://platform.claude.com/docs/en/build-with-claude/vision),
[Coordinates and bounding boxes](https://platform.claude.com/docs/en/build-with-claude/vision-coordinates)):

- An image costs `ceil(w/28) * ceil(h/28)` visual tokens - one per 28x28 patch.
- The standard tier (every model before Claude 4.7) downsizes any image past a
  1568px edge or 1568 visual tokens; the high-resolution tier (Claude 4.7 and
  later) allows 2576px and 4784 tokens. 1920x1080 costs 1560 tokens on the first
  (resized to 1456x819) and 2691 on the second.
- A request holding more than 20 images rejects any image over 2000px on a side.
  In Claude Code every earlier image is resent each turn, so a watch run crosses
  that line as soon as its frames are read.

So the default frame is the largest size that the standard tier accepts without
resizing, computed with the docs' own reference algorithm: every current model
then sees exactly the file on disk - no server-side resample, no bytes spent on
pixels that are thrown away - at ~1560 tokens. The old 960px default cost ~700
tokens for a 16:9 frame but halved a 1080p screen recording's linear
resolution, which is where small UI text stops being readable. `--tokens 4784`
spends up to 3x more on a high-resolution-tier model; its edge stops at 2000px
because of the many-image limit. `--n` stays at 24: frames cost nothing until
they are read, and with `--sheet 3x3` the whole run is three images.

Claude Code's Read tool (read from the bundled source of Claude Code 2.1.282)
also re-encodes any image over 512000 bytes as JPEG - a second lossy pass, which
the docs warn against. Real footage at the default size is far below that (a 4K
clip's frames measured 26-84 KB); grain or noise can pass it, and then the
frame is re-extracted from the source at a coarser quantiser so it is still only
compressed once.


## Tests

```
node --test test/watch.test.mjs
```

No test framework beyond Node's built-in `node:test`/`assert`. The script is
CLI-only, so tests drive it as a real subprocess against small clips
generated on the fly with `ffmpeg` (`lavfi` test patterns - nothing is
checked into the repo), and check its exit code, stderr, JSON manifest, and
the actual files it writes. Covers: the `--out` refusal on a populated
directory and the `--force` override, `--out` pointing at a file, a valueless
`--out`/`--mode` being refused instead of becoming the string "true", `--dry-run`
picking the same timestamps as the real run while writing nothing, `--label`
surviving a timestamp's colon through ffmpeg's drawtext escaping, `--n`
capping to the frames actually available, `--from`/`--to` range validation
(including an explicit `0` not being swallowed and an unreadable time being
refused), `mm:ss` time parsing, scene mode's cut-plus-fill top-up and its
honest fallback to `grid`, contact-sheet spec parsing, sizing to the vision budget (the default frame matches
the docs' 1456x819 example, `--tokens` and `--width` behave as documented, every
sheet fits the budget and says its real size, the last sheet drops empty rows, and
a grainy frame is brought under the Read byte budget), non-numeric values and an
unknown `--mode` being refused, and rotation handling
(coded vs. display size, portrait output, and the direction of the turn checked
against decoded pixels rather than dimensions).
