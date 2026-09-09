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
| `--width N` | `960` | target size for the long edge of the frame (not literally the pixel width - a portrait clip is sized on its height instead, so it isn't stretched wide). Never upscales past the source's own long edge. |
| `--from T` / `--to T` | clip start / end | restrict extraction to a time range. Accepts plain seconds (`90`, `12.5`) or a clock value (`mm:ss` or `hh:mm:ss`, e.g. `1:30` = 90s). An explicit `0` is honored (not read as "unset"), and a value that is not a time at all is refused rather than replaced by a default. |
| `--threshold F` | `0.3` | scene-change sensitivity for `--mode scene` (ffmpeg's `scene` score, 0-1). An explicit `0` is honored. |
| `--sheet CxR` | off | also tile frames into contact sheets, `C` columns by `R` rows per sheet - read these first, they're far cheaper than reading every frame individually. A spec with only one number (`--sheet 4`) sets the columns and leaves the rows at 3. |
| `--label` | off | burn the timestamp into the top-left corner of each frame. If ffmpeg can't parse the label filter for some reason, the script drops labels for the rest of the run and says why, rather than failing the whole extraction. |
| `--out DIR` | OS temp dir, under `video-watch/<slug>` | where frames are written. Refuses to touch a non-empty directory unless `--force` is given (an earlier version of this script wiped a project folder this way). Also refuses cleanly if `--out` points at an existing file. |
| `--force` | off | allow `--out` to overwrite a non-empty directory. |
| `--json` | off | print the manifest as JSON instead of the human-readable summary. |

The manifest (in both `--json` and plain-text form) always states what the run
actually did: which mode was used (including a fallback from `scene` to
`grid`), how many frames came from real scene cuts versus top-up fill, the
clip's coded size versus its display size when the source carries a rotation
tag, and the path/timestamp of every frame it wrote.

### Rotation

Phone and phone-screen recordings are commonly stored landscape with a
rotation tag telling the player to turn them for display (a portrait clip
whose *coded* frame is landscape). The script reads that rotation - from a
plain `rotate` stream tag or a `Display Matrix` side-data entry, whichever
the source carries - and uses the resulting *display* dimensions (not the
coded ones) to decide orientation, choose the scale target, and rotate the
extracted frame so it comes out upright at the right size.

## Tests

```
node --test test/watch.test.mjs
```

No test framework beyond Node's built-in `node:test`/`assert`. The script is
CLI-only, so tests drive it as a real subprocess against small clips
generated on the fly with `ffmpeg` (`lavfi` test patterns - nothing is
checked into the repo), and check its exit code, stderr, JSON manifest, and
the actual files it writes. Covers: the `--out` refusal on a populated
directory and the `--force` override, `--out` pointing at a file, `--label`
surviving a timestamp's colon through ffmpeg's drawtext escaping, `--n`
capping to the frames actually available, `--from`/`--to` range validation
(including an explicit `0` not being swallowed and an unreadable time being
refused), `mm:ss` time parsing, scene mode's cut-plus-fill top-up and its
honest fallback to `grid`, contact-sheet spec parsing, and rotation handling
(coded vs. display size, portrait output, and the direction of the turn checked
against decoded pixels rather than dimensions).
