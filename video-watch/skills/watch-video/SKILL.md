---
name: watch-video
description: Use when you need to see what is in a video file - a screen recording, a demo, a reference clip, a .mp4/.mkv/.mov/.webm the user points at, or any request to "watch", "look at", or "review" a video. Extracts frames with ffmpeg so they can be read as images.
---

# Watching a video

You cannot read a video file directly. Turn it into frames, then read the frames.

## Run

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/watch.mjs" "<video>" --n 24 --sheet 3x3 --label
```

Common flags:

| flag | meaning |
|---|---|
| `--n 24` | how many frames (default 24) |
| `--mode scene` | sample at scene changes instead of evenly - best for edited clips and UI recordings. Keeps every cut it finds and tops the rest of `--n` up with evenly spaced frames, so a slow clip still gets full coverage |
| `--sheet 3x3` | also build contact sheets: 9 frames per image, one Read each |
| `--label` | burn the timestamp into each frame |
| `--width 960` | frame width in px (default 960) |
| `--from T --to T` | only this time range - seconds (`90`) or a clock (`1:30`, `00:01:30`) |
| `--threshold F` | scene-change sensitivity for `--mode scene` (default 0.3, lower finds more cuts) |
| `--out DIR` | where frames go (default: the OS temp dir, under `video-watch/<slug>`) |
| `--force` | let `--out` overwrite a non-empty directory (refused otherwise) |
| `--json` | machine-readable manifest |

## Read

1. Read the **contact sheets** first. Nine frames per image is roughly nine times cheaper than nine reads, and it is usually enough to know what the video is.
2. Then read individual full-size frames only for the moments that matter. Sheets lose fine detail - small text, exact colors, thin strokes - so go to the full frame for anything you need to quote or copy.
3. Need the bit between two frames? Re-run with `--from`/`--to` and a higher `--n`.

## Notes

- Long video: start with `--n 16 --sheet 4x4` for the shape of it, then zoom into a range.
- Smooth motion or an animation you need to judge frame by frame: narrow `--from`/`--to` to a couple of seconds and raise `--n`.
- Sound is not extracted. If the answer is in the audio, say so rather than guessing from the picture.
- ffmpeg missing: `winget install --id Gyan.FFmpeg` (Windows), `brew install ffmpeg` (macOS), `apt-get install ffmpeg` (Linux). The script also finds winget's copy without a PATH refresh.
