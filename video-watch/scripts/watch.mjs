#!/usr/bin/env node
// video-watch - turn a video file into readable image frames.
// Usage:
//   node watch.mjs <video> [--n 24] [--mode grid|scene] [--tokens 1568] [--width PX]
//                          [--out DIR] [--force] [--sheet 3x3] [--from S] [--to S]
//                          [--threshold 0.3] [--label] [--json] [--dry-run]
// Prints a manifest of frame files + timestamps. Read the frames (or sheets)
// as images to actually see the video.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, renameSync, statSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

/* ---------- binary discovery ---------- */

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
    encoding: 'utf8',
  });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0];
  return null;
}

function findBin(name) {
  const envKey = name.toUpperCase().replace(/[^A-Z]/g, '') + '_PATH';
  if (process.env[envKey] && existsSync(process.env[envKey])) return process.env[envKey];
  const onPath = which(name);
  if (onPath) return onPath;
  // winget / common Windows install locations
  const roots = [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages'),
    'C:\\ffmpeg\\bin',
    'C:\\Program Files\\ffmpeg\\bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ].filter(Boolean);
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const direct = join(root, exe);
    if (existsSync(direct)) return direct;
    // one level of winget package folders, then their bin/
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || !/ffmpeg/i.test(e.name)) continue;
      const pkg = join(root, e.name);
      let subs = [];
      try {
        subs = readdirSync(pkg, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const s of [{ name: '.' }, ...subs]) {
        const cand = join(pkg, s.name, 'bin', exe);
        if (existsSync(cand)) return cand;
        const cand2 = join(pkg, s.name, exe);
        if (existsSync(cand2)) return cand2;
      }
    }
  }
  return null;
}

const FFMPEG = findBin('ffmpeg');
const FFPROBE = findBin('ffprobe');

if (!FFMPEG || !FFPROBE) {
  console.error(
    'video-watch: ffmpeg/ffprobe not found.\n' +
      '  Windows: winget install --id Gyan.FFmpeg --accept-package-agreements --accept-source-agreements\n' +
      '  macOS:   brew install ffmpeg\n' +
      '  Linux:   apt-get install ffmpeg\n' +
      'Or set FFMPEG_PATH / FFPROBE_PATH to the binaries.',
  );
  process.exit(2);
}

/* ---------- args ---------- */

const argv = process.argv.slice(2);
if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
  console.log(
    'Usage: node watch.mjs <video> [--n 24] [--mode grid|scene] [--tokens 1568] [--width PX]\n' +
      '                      [--out DIR] [--force] [--sheet 3x3] [--from S] [--to S]\n' +
      '                      [--threshold 0.3] [--label] [--json] [--dry-run]',
  );
  process.exit(argv.length ? 0 : 1);
}

const video = resolve(argv[0]);
if (!existsSync(video)) {
  console.error(`video-watch: no such file: ${video}`);
  process.exit(2);
}

// A trailing --out (or --mode, --width, --n, --from, --to, --threshold) with no
// value used to come back as `true`, so `String(flag('out'))` made a directory
// called "true" in the cwd and --mode fell through to grid without a word.
// Those flags are refused without a value, the way --from/--to refuse a bad
// time; --sheet and the booleans keep their bare form.
const NEEDS_VALUE = new Set(['out', 'mode', 'width', 'tokens', 'n', 'from', 'to', 'threshold']);
function flag(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    if (NEEDS_VALUE.has(name)) {
      console.error(`video-watch: --${name} needs a value`);
      process.exit(2);
    }
    return true;
  }
  return v;
}
const dryRun = argv.includes('--dry-run');

// `parsed || fallback` treats an explicit 0 the same as "missing" (0 is falsy), so
// e.g. --threshold 0 - a legitimate "flag every frame as a cut" request - silently
// became the 0.3 default. Number.isFinite tells "absent" from "really zero".
// A value that is there but is not a number (--n ten, --width 1080p) used to fall back
// to the default without a word - the run then sampled 24 frames at the default size
// while the caller believed it had asked for something else. Refused, like a bad time.
function numFlag(name, def, parseFn) {
  const raw = flag(name, undefined);
  if (raw === undefined) return def;
  const parsed = parseFn(raw);
  if (!Number.isFinite(parsed) || !/^\s*[-+]?(\d+\.?\d*|\.\d+)\s*$/.test(String(raw))) {
    console.error(`video-watch: --${name} must be a number (got ${raw})`);
    process.exit(2);
  }
  return parsed;
}

let n = Math.max(1, numFlag('n', 24, (v) => parseInt(v, 10))); // may be capped once fps/span are known
// An unrecognised --mode used to fall through to grid without a word, so `--mode
// scenes` - or any typo of "scene" - quietly sampled evenly and the caller only
// found out by noticing "[grid]" in the manifest. Refused for the same reason a
// valueless flag is: loudly wrong beats quietly wrong.
const MODES = new Set(['grid', 'scene']);
const mode = String(flag('mode', 'grid'));
if (!MODES.has(mode)) {
  console.error(`video-watch: --mode must be grid or scene (got ${mode})`);
  process.exit(2);
}
// Frame size is set by what Claude pays for, not by a guessed pixel width. Anthropic's
// vision docs (platform.claude.com/docs/en/build-with-claude/vision, and
// .../vision-coordinates, read 2026-09-25):
//   - an image costs ceil(w/28) * ceil(h/28) visual tokens (one per 28x28 patch);
//   - the standard tier (every model before Claude 4.7) downsizes anything over a 1568px
//     edge or 1568 visual tokens; the high-resolution tier (Claude 4.7 and later) allows
//     2576px and 4784 tokens;
//   - a request holding more than 20 images rejects any image over 2000px on a side.
// So the default frame is the largest size, at the clip's own aspect ratio, that the
// standard tier accepts WITHOUT resizing (a 16:9 clip lands at 1456x818, ~1560 tokens):
// every current model then sees exactly the pixels written here, with no server-side
// resample and no bytes spent on detail that is thrown away. The old 960px default used
// ~700 tokens for a 16:9 frame, but at half the linear resolution of a 1080p screen
// recording - small UI text, the thing these recordings are usually watched for, did not
// survive it. --tokens raises the budget for a high-resolution-tier model; the edge then
// stops at 2000px, the many-image limit above, because a watch run is always many images.
const PATCH = 28;
const STANDARD_TOKENS = 1568;
const STANDARD_EDGE = 1568;
const MANY_IMAGE_EDGE = 2000;
const widthGiven = argv.includes('--width');
const tokensGiven = argv.includes('--tokens');
const width = widthGiven ? Math.max(160, numFlag('width', 0, (v) => parseInt(v, 10))) : 0;
// 4784 is the largest budget any model takes (the high-resolution tier); past it the
// server downsizes, so a bigger number would only buy bytes that are thrown away
const HIRES_TOKENS = 4784;
const tokensAsked = Math.max(64, numFlag('tokens', STANDARD_TOKENS, (v) => parseInt(v, 10)));
const tokenBudget = Math.min(HIRES_TOKENS, tokensAsked);
if (tokensAsked > HIRES_TOKENS) {
  console.error(`video-watch: --tokens ${tokensAsked} is over ${HIRES_TOKENS}, the most any Claude model reads per image; using ${HIRES_TOKENS}`);
}
if (width > MANY_IMAGE_EDGE) {
  console.error(
    `video-watch: --width ${width} is over ${MANY_IMAGE_EDGE}px - the API rejects such an image once a request holds more than 20 images, and Claude Code's Read scales it to ${MANY_IMAGE_EDGE}px by default anyway`,
  );
}
const threshold = numFlag('threshold', 0.3, parseFloat);
const wantLabel = argv.includes('--label');
const asJson = argv.includes('--json');
const sheetSpec = flag('sheet', null);
const force = argv.includes('--force');

const slug = basename(video, extname(video)).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
const outDir = resolve(
  String(flag('out', join(process.env.CLAUDE_SCRATCHPAD || tmpdir(), 'video-watch', slug))),
);

/* ---------- probe ---------- */

function ffprobeJson(args) {
  const out = execFileSync(FFPROBE, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  return JSON.parse(out);
}

let meta;
try {
  meta = ffprobeJson([
    '-v', 'error',
    '-select_streams', 'v:0',
    // the display matrix lives in a NESTED section: "stream=side_data_list" prints the
    // section header with every field stripped ("side_data_list":[{}]), so the rotation
    // has to be asked for as stream_side_data=... or it silently never arrives
    '-show_entries',
    'stream=width,height,avg_frame_rate,codec_name:stream_side_data=side_data_type,rotation:stream_tags=rotate:format=duration,size',
    '-of', 'json',
    video,
  ]);
} catch (e) {
  // ffprobe throws on non-video/corrupt input rather than returning empty data,
  // so this needs its own catch or node prints a raw execFileSync stack trace
  const line = String(e.stderr || e.message || '').trim().split('\n')[0];
  console.error(`video-watch: ffprobe could not read ${video}: ${line}`);
  process.exit(2);
}
const vs = (meta.streams && meta.streams[0]) || {};
const duration = parseFloat((meta.format && meta.format.duration) || '0') || 0;
if (!duration) {
  console.error('video-watch: could not read duration (not a video?)');
  process.exit(2);
}
const [fnum, fden] = String(vs.avg_frame_rate || '0/1').split('/').map(Number);
const fps = fden ? +(fnum / fden).toFixed(3) : 0;

// --from/--to take plain seconds ("90", "12.5") or a clock ("mm:ss" / "hh:mm:ss",
// e.g. "1:30" = 90s) - a bare parseFloat("1:30") silently reads only "1" and the run
// samples the opening seconds while the user believes they asked for ninety.
function parseTimeSpec(v) {
  if (v === undefined || v === true) return NaN;
  const parts = String(v).split(':').map((p) => parseFloat(p));
  if (!parts.length || parts.some((p) => !Number.isFinite(p))) return NaN;
  return parts.reduce((secs, p) => secs * 60 + p, 0);
}

const fromRaw = parseTimeSpec(flag('from', '0'));
const toRaw = parseTimeSpec(flag('to', String(duration)));
// A time that cannot be read is refused rather than replaced with a default: falling back
// silently samples a different window than the caller asked for, which is the same
// failure "--from 1:30" used to produce - loudly wrong beats quietly wrong.
for (const [name, raw] of [['from', fromRaw], ['to', toRaw]]) {
  if (Number.isFinite(raw)) continue;
  console.error(`video-watch: --${name} is not a time (use ss, mm:ss or hh:mm:ss)`);
  process.exit(2);
}
// plain assignment, not `raw || default`: an explicit "--to 0" is a real zero and must
// reach the range check below instead of being read as "unset"
const from = Math.max(0, fromRaw);
const to = Math.min(duration, toRaw);
if (from >= duration || to <= from) {
  console.error(`video-watch: --from/--to must satisfy 0 <= from < to <= ${duration}`);
  process.exit(2);
}
const span = to - from;

// a --n above the real frame count spawns one ffmpeg per timestamp for no benefit -
// the extra timestamps land between frames and just duplicate the nearest one
const maxFrames = fps > 0 ? Math.max(1, Math.floor(span * fps)) : 0; // 0 = fps unknown
if (maxFrames && n > maxFrames) {
  console.error(
    `video-watch: --n ${n} exceeds the ~${maxFrames} distinct frames available in this range at ${fps}fps, capping to ${maxFrames}`,
  );
  n = maxFrames;
}

// ffmpeg's -ss rounds FORWARD: it hands back the first frame whose pts is at or after the
// timestamp, and if there is none (the request sits past the last frame) it decodes
// nothing at all and writes no file - a frame that was counted but never delivered. That
// is why "capping to 20" used to return 19: the last evenly spaced sample of a 2s 10fps
// clip is 1.95s, half a frame past the final frame at 1.9s.
// So sampling is done in FRAME INDEX space whenever the fps is known: pick frame k, then
// ask for it half a frame early, which is inside frame k under any rounding and can never
// run off the end of the clip. maxFrames may over-count by one on a VFR source; the half
// frame of backoff absorbs that too.
const frameTime = (k) => from + Math.max(0, Math.min(k, maxFrames - 1) - 0.5) / fps;
const snapToFrame = (t) => (maxFrames ? frameTime(Math.round((t - from) * fps)) : t);

/* ---------- pick timestamps ---------- */

function sceneTimes() {
  const r = spawnSync(
    FFMPEG,
    ['-hide_banner', '-nostats', '-ss', String(from), '-to', String(to), '-i', video,
     '-vf', `select='gt(scene,${threshold})',showinfo`, '-fps_mode', 'vfr', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 28 },
  );
  if (r.status !== 0) {
    // otherwise a real ffmpeg failure (e.g. -fps_mode missing on ffmpeg < 5.1) looks
    // identical to a clean "found 0 cuts" below
    const line = (r.stderr || '').trim().split('\n').filter(Boolean).pop() || 'unknown ffmpeg error';
    console.error(`video-watch: scene detection ffmpeg call failed: ${line}`);
  }
  const err = (r.stderr || '') + (r.stdout || '');
  const times = [];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(err))) times.push(from + parseFloat(m[1]));
  return times;
}

let times;
let usedMode = 'grid';
let sceneStats = null; // how many of the returned frames were real cuts vs. top-up fill
let cutTimes = new Set(); // the subset of `times` that are real cuts, for the manifest
if (mode === 'scene') {
  const found = [...new Set(sceneTimes().map((t) => +t.toFixed(3)))]
    .filter((t) => t > from && t < to)
    .sort((a, b) => a - b);
  if (found.length >= 2) {
    usedMode = 'scene';
    if (found.length >= n - 1) {
      // More cuts than there is room to fill around. A detected cut is the FIRST frame of
      // the scene AFTER it, so sampling only cuts never shows the opening scene at all -
      // this branch is the one where no fill is allocated to the run-in either, so it
      // keeps a head frame (as this script always did) and spends the rest on cuts.
      // Offset off the exact start for the usual reason: frame 0 is often black.
      const head = from + Math.min(0.2, span * 0.01);
      const keep = n - 1;
      const step = found.length / keep;
      times = [head, ...Array.from({ length: keep }, (_, i) => found[Math.floor(i * step)])];
    } else {
      // a clip that changes slowly between two cuts previously returned nothing for
      // that whole stretch - keep every cut, then spend the rest of the budget on the
      // largest gaps (including the run-in before the first cut and run-out after the
      // last) so a static-looking span still gets sampled instead of skipped entirely
      const fillCount = n - found.length; // the run-in gap below is what samples the opening scene
      const anchors = [from, ...found, to];
      const gaps = anchors.slice(1).map((end, i) => ({ start: anchors[i], end, size: end - anchors[i] }));
      gaps.sort((a, b) => b.size - a.size);
      const totalGapSize = gaps.reduce((s, g) => s + g.size, 0) || 1;
      // largest-remainder, not per-gap rounding: rounding each share independently can
      // hand out MORE frames than the budget (six equal gaps sharing three fills each
      // round 0.5 up to 1), and the surplus was then chopped off the end of the sorted
      // timestamps - silently discarding real cuts while the manifest still claimed them
      const exact = gaps.map((g) => (g.size / totalGapSize) * fillCount);
      const alloc = exact.map(Math.floor);
      const order = exact
        .map((e, i) => ({ i, frac: e - Math.floor(e) }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i); // ties go to the larger gap (gaps are size-sorted)
      let left = fillCount - alloc.reduce((a, b) => a + b, 0);
      for (let k = 0; left > 0; k++, left--) alloc[order[k % order.length].i]++;
      const fillTimes = [];
      gaps.forEach((g, i) => {
        // snapped for the same reason the grid is: the midpoint of a gap only one frame
        // wide sits past the last frame of that gap, where ffmpeg decodes nothing and the
        // fill silently never arrives
        for (let j = 1; j <= alloc[i]; j++) fillTimes.push(snapToFrame(g.start + (g.end - g.start) * (j / (alloc[i] + 1))));
      });
      times = [...found, ...fillTimes];
    }
    cutTimes = new Set(times.filter((t) => found.includes(t)).map((t) => +t.toFixed(3)));
  } else {
    console.error(`video-watch: scene mode found ${found.length} cuts, falling back to grid`);
    times = null;
  }
}
if (!times) {
  // evenly spaced, biased off the exact endpoints so we never land on a black frame.
  // With the fps known that spacing is measured in frames rather than seconds (see
  // frameTime): every sample then lands on a distinct real frame, so asking for the
  // capped count returns exactly the capped count instead of one short.
  times = maxFrames
    ? Array.from({ length: n }, (_, i) => frameTime(Math.floor(((i + 0.5) * maxFrames) / n)))
    : Array.from({ length: n }, (_, i) => from + span * ((i + 0.5) / n));
}
times = [...new Set(times.map((t) => +t.toFixed(3)))].sort((a, b) => a - b).slice(0, n);

/* ---------- extract ---------- */

const outGiven = argv.includes('--out');
if (!dryRun && existsSync(outDir)) {
  // readdirSync on a file throws ENOTDIR, and the guard below was the first
  // thing to touch it - so --out pointing at a file came back as a raw stack
  // trace rather than the one-line refusal every other bad argument gets.
  if (!statSync(outDir).isDirectory()) {
    console.error(`video-watch: --out ${outDir} exists and is not a directory.`);
    process.exit(2);
  }
  // the default tmp/video-watch/<slug> dir is ours to wipe every run, but a
  // user-supplied --out is someone else's directory (an earlier run of this script
  // wiped a project folder this way) - refuse unless it's empty or --force is given
  if (outGiven && readdirSync(outDir).length && !force) {
    console.error(
      `video-watch: --out ${outDir} already exists and is not empty.\n` +
        '  Refusing to delete its contents. Pass --force to overwrite, or use an empty/new directory.',
    );
    process.exit(2);
  }
  rmSync(outDir, { recursive: true, force: true });
}
if (!dryRun) mkdirSync(outDir, { recursive: true });

const FONT =
  process.platform === 'win32'
    ? 'C\\:/Windows/Fonts/consola.ttf'
    : process.platform === 'darwin'
      ? '/System/Library/Fonts/Supplemental/Courier New.ttf'
      : '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf';

// phone/screen recordings are routinely stored landscape with a rotation telling the
// player to turn them 90 or 270 degrees for display - the CODED width/height above
// describe the stored pixels, not what a viewer sees, so orientation and scale must use
// the DISPLAY size. ffmpeg carries the rotation two ways: a Display Matrix side_data
// entry (mp4/mov, and what every current ffmpeg writes) or a legacy "rotate" stream tag
// (older mp4 muxers, matroska). Side data wins when both are present: it is what ffmpeg's
// own autorotate acts on, so trusting it keeps us in step with the decoder.
//
// Signs, measured against ffmpeg's autorotate output (ffmpeg 9, mp4 display matrix):
// side_data rotation +90 needs a 90 counter-clockwise turn to display, -90 needs 90
// clockwise, -180 needs 180 - i.e. the clockwise turn we owe is -rotation. The legacy
// tag uses the opposite sign (rotate=90 means "turn 90 clockwise"), which is why the
// two branches differ.
function getRotation(stream) {
  const norm = (deg) => ((Math.round(deg) % 360) + 360) % 360;
  const dm = (stream.side_data_list || []).find((s) => typeof s.rotation === 'number');
  if (dm) return norm(-dm.rotation);
  const tag = stream.tags && (stream.tags.rotate ?? stream.tags.ROTATE);
  if (tag !== undefined && Number.isFinite(parseInt(tag, 10))) return norm(parseInt(tag, 10));
  return 0;
}
const rotation = getRotation(vs); // one of 0, 90, 180, 270 - the clockwise turn needed to view it upright
const swapped = rotation === 90 || rotation === 270;
const codedW = vs.width || 0;
const codedH = vs.height || 0;
// display dims are what orientation/scale decisions must use; coded dims are only for
// the transpose filter below, which runs on the coded frame before it's swapped
const vw = swapped ? codedH : codedW;
const vh = swapped ? codedW : codedH;
const portrait = vh > vw;

/* ---------- sizing to Claude's vision budget ---------- */

const visualTokens = (w, h) => Math.ceil(w / PATCH) * Math.ceil(h / PATCH);
// Python-style round (ties to even), as the docs' reference implementation specifies:
// the API resolves exact .5 ties toward the even neighbour.
function roundHalfEven(v) {
  const f = Math.floor(v);
  if (v - f !== 0.5) return Math.round(v);
  return f % 2 === 0 ? f : f + 1;
}
// Anthropic's reference resize (vision-coordinates, "Resize your image before
// uploading"): the largest aspect-preserving size whose 28px-padded edges fit maxEdge
// and whose patch count fits maxTokens. Returns the input unchanged when it already fits.
function fitsBudget(w, h, maxEdge, maxTokens) {
  return Math.ceil(w / PATCH) * PATCH <= maxEdge && Math.ceil(h / PATCH) * PATCH <= maxEdge &&
    visualTokens(w, h) <= maxTokens;
}
function fitSize(w, h, maxEdge, maxTokens) {
  if (fitsBudget(w, h, maxEdge, maxTokens)) return [w, h];
  if (h > w) {
    const [rh, rw] = fitSize(h, w, maxEdge, maxTokens);
    return [rw, rh];
  }
  const aspect = w / h;
  let lo = 1;
  let hi = w;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fitsBudget(mid, Math.max(roundHalfEven(mid / aspect), 1), maxEdge, maxTokens)) lo = mid;
    else hi = mid;
  }
  return [lo, Math.max(roundHalfEven(lo / aspect), 1)];
}
// yuv420 JPEG wants even dimensions; rounding DOWN can only lower the patch count, so an
// evened size still fits whatever budget the unevened one did
const evenDown = (v) => Math.max(2, Math.floor(v / 2) * 2);

// The edge that goes with the token budget: the standard tier's 1568px for the default
// budget, the many-image 2000px for anything larger (see the note at --tokens).
const budgetEdge = tokenBudget > STANDARD_TOKENS ? MANY_IMAGE_EDGE : STANDARD_EDGE;

// The exact frame size, decided once, so the manifest can state what each frame costs.
// --width alone keeps its old meaning (the long edge, never upscaled); --tokens alone,
// or neither, fits the budget; both together fit the budget inside that long edge.
function pickFrameSize() {
  if (!vw || !vh) return null; // dimensions unknown - ffmpeg sizes it, the manifest says so
  const srcLong = Math.max(vw, vh);
  const long = widthGiven ? Math.min(width, srcLong) : srcLong;
  let w = portrait ? Math.round((vw * long) / vh) : long;
  let h = portrait ? long : Math.round((vh * long) / vw);
  if (!widthGiven || tokensGiven) [w, h] = fitSize(w, h, budgetEdge, tokenBudget);
  return [evenDown(w), evenDown(h)];
}
const frameSize = pickFrameSize();
function frameScale() {
  if (!frameSize) return `scale=${width || 1456}:-2`;
  return `scale=${frameSize[0]}:${frameSize[1]}`;
}

// Claude Code's Read tool re-encodes an image over 512000 bytes (read from the bundled
// source of Claude Code 2.1.282: FileRead's byte budget UCe=512000, then a JPEG quality
// search) - a second lossy pass, which Anthropic's docs single out as harmful ("especially
// when multiple compression passes are applied"). Real footage at the default size is far
// under it (a 4K clip's frames measured 26-84 KB at 1456x818); film grain or noise can
// pass it, and then the frame is re-extracted from the SOURCE at a coarser quantiser, so
// it is still only ever compressed once.
const MAX_IMAGE_BYTES = 512000;
const QUALITY_STEPS = [3, 5, 8, 12, 18, 25];

// Rotate explicitly rather than leaning on ffmpeg's autorotate: autorotate ignores the
// legacy "rotate" tag (matroska), and the frameScale math above is written in display
// terms, so the two must not disagree about whether the frame arrived turned. When this
// returns a filter, extract() also passes -noautorotate so the turn happens exactly once.
// When it returns null - no rotation, or an odd angle that is not a quarter turn -
// autorotate is left alone, so an angle we failed to read still comes out upright
// (merely mis-scaled) instead of sideways.
function rotateFilter() {
  if (rotation === 90) return 'transpose=1'; // 90 clockwise
  if (rotation === 270) return 'transpose=2'; // 90 counter-clockwise
  if (rotation === 180) return 'transpose=2,transpose=2';
  return null;
}

// ffmpeg's filtergraph parser treats ':' as an option separator even inside a quoted
// drawtext value, so a literal colon in the label text (e.g. "00:01.0") has to be
// escaped or the whole -vf string fails to parse (same idiom as the FONT path above)
function escapeDrawtext(s) {
  return String(s).replace(/:/g, '\\:');
}

function stamp(t) {
  // round first - splitting an unrounded t just under a minute boundary (e.g. 59.96)
  // prints "00:60.0" instead of "01:00.0"
  const r = Math.round(t * 10) / 10;
  const mm = String(Math.floor(r / 60)).padStart(2, '0');
  const ss = (r % 60).toFixed(1).padStart(4, '0');
  return `${mm}:${ss}`;
}

function extractArgs(t, file, label, q = QUALITY_STEPS[0]) {
  const rf = rotateFilter();
  const vf = [];
  if (rf) vf.push(rf); // rotate first - scale/crop math below is all in display-orientation terms
  vf.push(frameScale());
  if (label) {
    // sized off the frame's short edge (4%, never under the old fixed 22px) so the stamp
    // is still legible once a frame is shrunk to a third of its width in a 3x3 sheet
    const fs = frameSize ? Math.max(22, Math.round(Math.min(...frameSize) * 0.04)) : 22;
    const pad = Math.round(fs * 0.45);
    vf.push(
      `drawtext=fontfile='${FONT}':text='${escapeDrawtext(label)}':x=${pad}:y=${pad}:fontsize=${fs}:` +
        `fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=${Math.round(fs * 0.27)}`,
    );
  }
  return ['-hide_banner', '-loglevel', 'error',
    ...(rf ? ['-noautorotate'] : []), // input option: must precede -i
    '-ss', String(t), '-i', video,
    '-frames:v', '1', '-vf', vf.join(','), '-q:v', String(q), '-y', file];
}

// Runs one encode per quality step until the file fits MAX_IMAGE_BYTES. Every attempt
// starts from the same input (the video for a frame, the frames for a sheet), never
// from the previous attempt's output, so no retry stacks a compression pass on another.
function encodeUnderBudget(argsFor, file) {
  let r;
  for (const q of QUALITY_STEPS) {
    r = spawnSync(FFMPEG, argsFor(q), { encoding: 'utf8' });
    r.ok = r.status === 0 && existsSync(file);
    r.q = q;
    if (!r.ok || statSync(file).size <= MAX_IMAGE_BYTES) return r;
  }
  return r; // the coarsest step is still over: keep it, Read will squeeze it the rest of the way
}

function extract(t, file, label) {
  return encodeUnderBudget((q) => extractArgs(t, file, label, q), file);
}

// --dry-run: everything decided, nothing spawned for frames and nothing written.
// The timestamps are the same ones a real run extracts, so a long file can be
// checked in seconds before spending one ffmpeg call per frame.
if (dryRun) {
  const firstFile = join(outDir, 'f001.jpg');
  const plan = {
    dryRun: true,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    video,
    duration: +duration.toFixed(2),
    size: `${vw}x${vh}`,
    codedSize: rotation ? `${codedW}x${codedH}` : undefined,
    rotation: rotation || undefined,
    fps,
    codec: vs.codec_name,
    mode: usedMode,
    frameSize: frameSize ? `${frameSize[0]}x${frameSize[1]}` : undefined,
    tokensPerFrame: frameSize ? visualTokens(...frameSize) : undefined,
    outDir,
    times,
    argv: extractArgs(times[0], firstFile, wantLabel ? stamp(times[0]) : null),
    sheetSpec: sheetSpec === true ? '3x3' : sheetSpec || undefined,
  };
  if (asJson) {
    console.log(JSON.stringify(plan, null, 2));
  } else {
    const rot = plan.rotation ? `  [rotated ${plan.rotation} clockwise from ${plan.codedSize}]` : '';
    console.log(`${basename(video)}  ${plan.size} @ ${fps}fps  ${plan.duration}s  (${plan.codec})${rot}`);
    console.log(`dry run: ${times.length} frames [${usedMode}] would go to ${outDir} (not created)`);
    if (frameSize) console.log(`frame size: ${plan.frameSize}, ~${plan.tokensPerFrame} visual tokens each`);
    console.log(`ffmpeg: ${FFMPEG}\nffprobe: ${FFPROBE}`);
    console.log(`first frame: ffmpeg ${plan.argv.join(' ')}`);
    console.log(`\nTimestamps:`);
    times.forEach((t, i) => console.log(`  ${String(i + 1).padStart(3)} ${stamp(t)}  (${t}s)`));
  }
  process.exit(0);
}

const frames = [];
let labelOk = wantLabel;
for (let i = 0; i < times.length; i++) {
  const t = times[i];
  const file = join(outDir, `f${String(i + 1).padStart(3, '0')}.jpg`);
  let r = extract(t, file, labelOk ? stamp(t) : null);
  if (!r.ok && labelOk) {
    labelOk = false; // drop labels for the rest, but say why instead of failing silently
    const line = (r.stderr || '').trim().split('\n').filter(Boolean).pop() || 'unknown ffmpeg error';
    console.error(`video-watch: --label extract failed (${line}), continuing without labels`);
    r = extract(t, file, null);
  }
  if (r.ok) {
    if (r.q !== QUALITY_STEPS[0]) {
      console.error(
        `video-watch: frame at ${stamp(t)} was over ${MAX_IMAGE_BYTES / 1000} KB at the default quality, re-encoded from the source at -q:v ${r.q}`,
      );
    }
    frames.push({ i: frames.length + 1, t, file, q: r.q });
  } else {
    // a frame that failed used to drop out of the manifest without a word, and a run
    // where every frame failed said only "extracted no frames" - never why
    const line = (r.stderr || '').trim().split('\n').filter(Boolean).pop() ||
      (r.error ? r.error.message : `ffmpeg exited ${r.status ?? r.signal} and wrote no file`);
    console.error(`video-watch: frame at ${stamp(t)} failed: ${line}`);
  }
}

if (!frames.length) {
  console.error('video-watch: extracted no frames');
  process.exit(1);
}

/* ---------- contact sheets ---------- */

const sheets = [];
if (sheetSpec) {
  // the same two traps as the other numeric flags, on the one flag that was missed:
  // `parseInt(v) || 3` read an explicit 0 as "absent" and handed back the 3 default, and
  // a spec with no 'x' in it (--sheet 4) left rows undefined, so per was NaN, the loop
  // below never ran and the run produced no sheets at all without saying a word
  const parts = String(sheetSpec === true ? '3x3' : sheetSpec).split('x');
  const dim = (v) => {
    const k = parseInt(v, 10);
    return Math.max(1, Number.isFinite(k) ? k : 3);
  };
  const cols = dim(parts[0]);
  const rows = dim(parts[1]);
  const per = cols * rows;
  // A sheet is one image, so it is priced like one: the whole sheet - tiles, the 6px
  // margin and the 6px gaps - is fitted to the same budget as a frame. Before, a 3x3
  // sheet of 960px frames came out 1944px wide: past the standard tier's 1568px edge, so
  // the API resampled it and the pixels past the fit were paid for in bytes and thrown
  // away. Now the sheet is exactly what the model sees. Tiles never upscale past the
  // frame, and keep the frame's orientation (a portrait clip's tiles are portrait).
  const MARGIN = 6;
  const GAP = 6;
  const [fw, fh] = frameSize || [0, 0];
  const sheetDims = (tw, th, c, rr) => [2 * MARGIN + c * tw + (c - 1) * GAP, 2 * MARGIN + rr * th + (rr - 1) * GAP];
  function tileFor(c, rr) {
    if (!fw || !fh) return null;
    // walk the tile's long edge down from the frame's until the sheet fits the budget
    const long = Math.max(fw, fh);
    for (let L = long; L >= 16; L -= 2) {
      const tw = evenDown(fw >= fh ? L : (fw * L) / fh);
      const th = evenDown(fw >= fh ? (fh * L) / fw : L);
      const [sw, sh] = sheetDims(tw, th, c, rr);
      if (fitsBudget(sw, sh, budgetEdge, tokenBudget)) return [tw, th];
    }
    return [16, 16];
  }
  const seqDir = join(outDir, '_seq');
  for (let s = 0; s * per < frames.length; s++) {
    const chunk = frames.slice(s * per, s * per + per);
    // the last sheet keeps the column count but drops the rows it has nothing for:
    // 24 frames at 3x3 used to end on a sheet that was one third empty tiles, priced as
    // a full sheet. Now it is 3x2: cheaper (a 16:9 clip's 3x2 is ~1230 tokens against
    // ~1560 for 3x3), with tiles as large as the edge limit then allows.
    const rowsHere = Math.min(rows, Math.ceil(chunk.length / cols));
    const tile = tileFor(cols, rowsHere);
    // dimensions unknown (no frameSize): fall back to the old width-per-column sizing
    const tileScale = tile ? `scale=${tile[0]}:${tile[1]}` : `scale=${Math.round(1456 / cols) * 2}:-2`;
    if (existsSync(seqDir)) rmSync(seqDir, { recursive: true, force: true });
    mkdirSync(seqDir, { recursive: true });
    chunk.forEach((f, k) =>
      renameSync(f.file, join(seqDir, `s${String(k + 1).padStart(3, '0')}.jpg`)),
    );
    const sheet = join(outDir, `sheet${s + 1}.jpg`);
    const r = encodeUnderBudget(
      (q) => ['-hide_banner', '-loglevel', 'error', '-start_number', '1',
        '-i', join(seqDir, 's%03d.jpg'),
        '-vf', `${tileScale},tile=${cols}x${rowsHere}:margin=${MARGIN}:padding=${GAP}:color=0x111111`,
        '-frames:v', '1', '-q:v', String(q), '-y', sheet],
      sheet,
    );
    chunk.forEach((f, k) => renameSync(join(seqDir, `s${String(k + 1).padStart(3, '0')}.jpg`), f.file));
    if (r.ok) {
      const size = tile ? sheetDims(tile[0], tile[1], cols, rowsHere) : null;
      sheets.push({
        file: sheet,
        cols,
        rows: rowsHere,
        frames: chunk.map((f) => f.i),
        size: size ? `${size[0]}x${size[1]}` : undefined,
        tokens: size ? visualTokens(...size) : undefined,
      });
    } else {
      // a sheet that failed used to vanish from the manifest without a word
      const line = (r.stderr || '').trim().split('\n').filter(Boolean).pop() || 'unknown ffmpeg error';
      console.error(`video-watch: contact sheet ${s + 1} failed (${line}); its frames are still listed below`);
    }
  }
  if (existsSync(seqDir)) rmSync(seqDir, { recursive: true, force: true });
}

/* ---------- report ---------- */

// counted from the frames that were really written, after the dedupe, the --n cap and
// any failed extract - a manifest that claims cuts the caller cannot look at is worse
// than no manifest at all
if (usedMode === 'scene') {
  const cuts = frames.filter((f) => cutTimes.has(f.t)).length;
  sceneStats = { cuts, fill: frames.length - cuts };
}

const report = {
  video,
  duration: +duration.toFixed(2),
  size: `${vw}x${vh}`, // display size (post-rotation), what the frames actually look like
  codedSize: rotation ? `${codedW}x${codedH}` : undefined,
  rotation: rotation || undefined,
  fps,
  codec: vs.codec_name,
  mode: usedMode,
  sceneStats: sceneStats || undefined, // {cuts, fill} - only meaningful when mode === 'scene'
  // the size every frame was written at, and what one costs to Read under Anthropic's
  // ceil(w/28)*ceil(h/28) rule - so a caller can decide what to look at before looking
  frameSize: frameSize ? `${frameSize[0]}x${frameSize[1]}` : undefined,
  tokensPerFrame: frameSize ? visualTokens(...frameSize) : undefined,
  outDir,
  labels: labelOk,
  frames: frames.map((f) => ({
    n: f.i,
    t: f.t,
    at: stamp(f.t),
    file: f.file,
    ...(f.q !== QUALITY_STEPS[0] && { q: f.q }), // only when it had to be re-encoded coarser
  })),
  sheets,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const rot = report.rotation
    ? `  [rotated ${report.rotation} clockwise from ${report.codedSize}]`
    : '';
  console.log(
    `${basename(video)}  ${report.size} @ ${fps}fps  ${report.duration}s  (${report.codec})${rot}`,
  );
  const sceneNote = sceneStats ? ` (${sceneStats.cuts} cuts + ${sceneStats.fill} fill)` : '';
  const cost = report.frameSize ? `  ${report.frameSize}, ~${report.tokensPerFrame} visual tokens each` : '';
  console.log(`${frames.length} frames [${report.mode}]${sceneNote}${cost} -> ${outDir}`);
  if (sheets.length) {
    console.log(`\nContact sheets (read these first):`);
    for (const s of sheets) {
      const a = frames.find((f) => f.i === s.frames[0]);
      const b = frames.find((f) => f.i === s.frames[s.frames.length - 1]);
      const sc = s.tokens ? `, ~${s.tokens} tokens` : '';
      console.log(`  ${s.file}  ${s.cols}x${s.rows}  ${stamp(a.t)}-${stamp(b.t)} (frames ${s.frames[0]}-${s.frames[s.frames.length - 1]}, left-to-right, top-to-bottom${sc})`);
    }
  }
  console.log(`\nFrames:`);
  for (const f of frames) console.log(`  ${String(f.i).padStart(3)} ${stamp(f.t)}  ${f.file}`);
}
