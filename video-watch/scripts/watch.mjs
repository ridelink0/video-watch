#!/usr/bin/env node
// video-watch - turn a video file into readable image frames.
// Usage:
//   node watch.mjs <video> [--n 24] [--mode grid|scene] [--width 960]
//                          [--out DIR] [--force] [--sheet 3x3] [--from S] [--to S]
//                          [--threshold 0.3] [--label] [--json]
// Prints a manifest of frame files + timestamps. Read the frames (or sheets)
// as images to actually see the video.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readdirSync, renameSync } from 'node:fs';
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

let n = Math.max(1, parseInt(flag('n', '24'), 10) || 24); // may be capped once fps/span are known
const mode = String(flag('mode', 'grid'));
const width = Math.max(160, parseInt(flag('width', '960'), 10) || 960);
const threshold = parseFloat(flag('threshold', '0.3')) || 0.3;
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
    '-show_entries', 'stream=width,height,avg_frame_rate,codec_name:format=duration,size',
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

const fromRaw = parseFloat(flag('from', '0'));
const from = Math.max(0, Number.isFinite(fromRaw) ? fromRaw : 0);
// Number.isFinite (not ||) so an explicit "--to 0" is honored instead of read as "unset"
const toRaw = parseFloat(flag('to', String(duration)));
const to = Math.min(duration, Number.isFinite(toRaw) ? toRaw : duration);
if (from >= duration || to <= from) {
  console.error(`video-watch: --from/--to must satisfy 0 <= from < to <= ${duration}`);
  process.exit(2);
}
const span = to - from;

// a --n above the real frame count spawns one ffmpeg per timestamp for no benefit -
// the extra timestamps land between frames and just duplicate the nearest one
if (fps > 0) {
  const maxFrames = Math.max(1, Math.floor(span * fps));
  if (n > maxFrames) {
    console.error(
      `video-watch: --n ${n} exceeds the ~${maxFrames} distinct frames available in this range at ${fps}fps, capping to ${maxFrames}`,
    );
    n = maxFrames;
  }
}

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
if (mode === 'scene') {
  const found = sceneTimes();
  if (found.length >= 2) {
    usedMode = 'scene';
    // keep at most n, evenly sampled across the detected cuts, always include the first frame
    times = [from + Math.min(0.2, span * 0.01)];
    if (found.length <= n - 1) times.push(...found);
    else {
      const step = found.length / (n - 1);
      for (let i = 0; i < n - 1; i++) times.push(found[Math.floor(i * step)]);
    }
  } else {
    console.error(`video-watch: scene mode found ${found.length} cuts, falling back to grid`);
    times = null;
  }
}
if (!times) {
  // evenly spaced, biased off the exact endpoints so we never land on a black frame
  times = Array.from({ length: n }, (_, i) => from + span * ((i + 0.5) / n));
}
times = [...new Set(times.map((t) => +t.toFixed(3)))].sort((a, b) => a - b).slice(0, n);

/* ---------- extract ---------- */

const outGiven = argv.includes('--out');
if (existsSync(outDir)) {
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

// --width names the long edge, not literally "width": a portrait clip should sample
// onto its (taller) height axis instead of being stretched wide, and should never be
// upscaled past the source's own long edge
const vw = vs.width || 0;
const vh = vs.height || 0;
const portrait = vh > vw;
function frameScale(w) {
  if (!vw || !vh) return `scale=${w}:-2`; // dimensions unknown - fall back to the old behavior
  const target = Math.min(w, Math.max(vw, vh));
  return portrait ? `scale=-2:${target}` : `scale=${target}:-2`;
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
  const vf = [frameScale(width)];
  if (label) {
    vf.push(
      `drawtext=fontfile='${FONT}':text='${escapeDrawtext(label)}':x=10:y=10:fontsize=22:` +
        `fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=6`,
    );
  }
  const r = spawnSync(
    FFMPEG,
    ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', video,
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
  const [cols, rows] = String(sheetSpec === true ? '3x3' : sheetSpec)
    .split('x')
    .map((v) => Math.max(1, parseInt(v, 10) || 3));
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

const report = {
  video,
  duration: +duration.toFixed(2),
  size: `${vs.width}x${vs.height}`,
  fps,
  codec: vs.codec_name,
  mode: usedMode,
  outDir,
  labels: labelOk,
  frames: frames.map((f) => ({ n: f.i, t: f.t, at: stamp(f.t), file: f.file })),
  sheets,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(
    `${basename(video)}  ${report.size} @ ${fps}fps  ${report.duration}s  (${report.codec})`,
  );
  console.log(`${frames.length} frames [${report.mode}] -> ${outDir}`);
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
