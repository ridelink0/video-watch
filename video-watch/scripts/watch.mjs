#!/usr/bin/env node
// video-watch - turn a video file into readable image frames.
// Usage:
//   node watch.mjs <video> [--n 24] [--mode grid|scene] [--width 960]
//                          [--out DIR] [--force] [--sheet 3x3] [--from S] [--to S]
//                          [--threshold 0.3] [--label] [--json]
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
    'Usage: node watch.mjs <video> [--n 24] [--mode grid|scene] [--width 960]\n' +
      '                      [--out DIR] [--force] [--sheet 3x3] [--from S] [--to S]\n' +
      '                      [--threshold 0.3] [--label] [--json]',
  );
  process.exit(argv.length ? 0 : 1);
}

const video = resolve(argv[0]);
if (!existsSync(video)) {
  console.error(`video-watch: no such file: ${video}`);
  process.exit(2);
}

function flag(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}

// `parsed || fallback` treats an explicit 0 the same as "missing" (0 is falsy), so
// e.g. --threshold 0 - a legitimate "flag every frame as a cut" request - silently
// became the 0.3 default. Number.isFinite tells "absent/garbage" from "really zero".
function numFlag(name, def, parseFn) {
  const parsed = parseFn(flag(name, String(def)));
  return Number.isFinite(parsed) ? parsed : def;
}

let n = Math.max(1, numFlag('n', 24, (v) => parseInt(v, 10))); // may be capped once fps/span are known
const mode = String(flag('mode', 'grid'));
const width = Math.max(160, numFlag('width', 960, (v) => parseInt(v, 10)));
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
if (existsSync(outDir)) {
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
mkdirSync(outDir, { recursive: true });

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
function frameScale(w) {
  if (!vw || !vh) return `scale=${w}:-2`; // dimensions unknown - fall back to the old behavior
  const target = Math.min(w, Math.max(vw, vh));
  return portrait ? `scale=-2:${target}` : `scale=${target}:-2`;
}
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

function extract(t, file, label) {
  const rf = rotateFilter();
  const vf = [];
  if (rf) vf.push(rf); // rotate first - scale/crop math below is all in display-orientation terms
  vf.push(frameScale(width));
  if (label) {
    vf.push(
      `drawtext=fontfile='${FONT}':text='${escapeDrawtext(label)}':x=10:y=10:fontsize=22:` +
        `fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6`,
    );
  }
  const r = spawnSync(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error',
     ...(rf ? ['-noautorotate'] : []), // input option: must precede -i
     '-ss', String(t), '-i', video,
     '-frames:v', '1', '-vf', vf.join(','), '-q:v', '3', '-y', file],
    { encoding: 'utf8' },
  );
  r.ok = r.status === 0 && existsSync(file);
  return r;
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
  if (r.ok) frames.push({ i: frames.length + 1, t, file });
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
  const seqDir = join(outDir, '_seq');
  for (let s = 0; s * per < frames.length; s++) {
    const chunk = frames.slice(s * per, s * per + per);
    if (existsSync(seqDir)) rmSync(seqDir, { recursive: true, force: true });
    mkdirSync(seqDir, { recursive: true });
    chunk.forEach((f, k) =>
      renameSync(f.file, join(seqDir, `s${String(k + 1).padStart(3, '0')}.jpg`)),
    );
    const sheet = join(outDir, `sheet${s + 1}.jpg`);
    const r = spawnSync(
      FFMPEG,
      ['-hide_banner', '-loglevel', 'error', '-start_number', '1',
       '-i', join(seqDir, 's%03d.jpg'),
       '-vf', `scale=${Math.round(width / cols) * 2}:-2,tile=${cols}x${rows}:margin=6:padding=6:color=0x111111`,
       '-frames:v', '1', '-q:v', '3', '-y', sheet],
      { encoding: 'utf8' },
    );
    chunk.forEach((f, k) => renameSync(join(seqDir, `s${String(k + 1).padStart(3, '0')}.jpg`), f.file));
    if (r.status === 0 && existsSync(sheet)) {
      sheets.push({ file: sheet, cols, rows, frames: chunk.map((f) => f.i) });
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
  outDir,
  labels: labelOk,
  frames: frames.map((f) => ({ n: f.i, t: f.t, at: stamp(f.t), file: f.file })),
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
  console.log(`${frames.length} frames [${report.mode}]${sceneNote} -> ${outDir}`);
  if (sheets.length) {
    console.log(`\nContact sheets (read these first):`);
    for (const s of sheets) {
      const a = frames.find((f) => f.i === s.frames[0]);
      const b = frames.find((f) => f.i === s.frames[s.frames.length - 1]);
      console.log(`  ${s.file}  ${s.cols}x${s.rows}  ${stamp(a.t)}-${stamp(b.t)} (frames ${s.frames[0]}-${s.frames[s.frames.length - 1]}, left-to-right, top-to-bottom)`);
    }
  }
  console.log(`\nFrames:`);
  for (const f of frames) console.log(`  ${String(f.i).padStart(3)} ${stamp(f.t)}  ${f.file}`);
}
