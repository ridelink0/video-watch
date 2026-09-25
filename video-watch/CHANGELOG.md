# Changelog

## 1.2.0 - 2026-09-25

Frames and contact sheets are now sized by what Claude pays for them, checked
against Anthropic's vision docs (see "Why these defaults" in the README).

- **Default frame size fits the standard vision tier exactly.** Instead of a
  fixed 960px long edge, a frame is written at the largest size, at the clip's
  aspect ratio, that every current Claude model reads without resizing: 1456x818
  for 16:9 (~1560 visual tokens, `ceil(w/28) * ceil(h/28)`), computed with the
  docs' reference resize. The old default spent ~700 tokens on half the linear
  resolution of a 1080p recording, where small UI text no longer survives.
- **`--tokens N`** sets the per-image budget (default 1568, capped at 4784, the
  most any model reads). Above 1568 the edge limit is 2000px, the API's limit
  for a request holding more than 20 images.
- `--width N` keeps its meaning (the long edge, never upscaled); combined with
  `--tokens` the frame fits the budget inside that edge. Over 2000px it warns.
- **Contact sheets fit the same budget**, margins and gaps included, so a sheet
  is exactly what the model sees (a 3x3 sheet of 960px frames used to be 1944px
  wide and resampled server-side). Portrait clips keep portrait tiles.
- **The last sheet drops empty rows**: 24 frames at 3x3 end on a 3x2 sheet
  instead of a 3x3 sheet one third blank (~1230 tokens instead of ~1560 for a
  16:9 clip).
- **No second JPEG pass in Claude Code**: its Read tool (2.1.282) re-encodes any
  image over 512000 bytes. A frame or sheet over that is re-extracted from the
  source at a coarser `-q:v`, said on stderr and recorded as `q` in the manifest.
- The manifest and `--dry-run` report `frameSize` and `tokensPerFrame`; each
  sheet reports its `size` and `tokens`.
- `--label` stamps scale with the frame (4% of the short edge, at least 22px), so
  they stay legible inside a contact sheet.
- A non-numeric `--n`, `--width`, `--tokens` or `--threshold` is refused instead
  of silently becoming the default; an unknown `--mode` (e.g. `scenes`) is
  refused instead of silently running grid.
- A frame or contact sheet that fails to build is reported on stderr with
  ffmpeg's last error line, instead of silently dropping out of the manifest.

## 1.1.1+ (unreleased, shipped in the 1.1.1 install)

- `--dry-run` prints the plan and writes nothing.
- A valueless `--out`, `--mode`, `--width`, `--n`, `--from`, `--to` or
  `--threshold` is refused instead of becoming the string "true".
- `--width` documented as the long edge; LICENSE ships with the plugin.

## 1.1.1

- The `--n` cap delivers exactly the number it announces.

## 1.1.0

- Rotated clips, scene mode that fills to `--n`, `hh:mm:ss` times, and a test
  suite.

## 1.0.2

- `--out` pointing at a file is refused instead of throwing a stack trace.

## 1.0.1

- The listing no longer advertises audio transcription it does not have.

## 1.0.0

- First release: frame extraction with ffmpeg, contact sheets, timestamps.
