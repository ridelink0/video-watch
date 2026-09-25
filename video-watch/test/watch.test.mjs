// Smoke tests for scripts/watch.mjs. No test framework beyond node:test/assert -
// the plugin is zero-dependency, and the test suite follows that.
//
// The script is CLI-only (no exports), so these drive it as a real subprocess
// against small ffmpeg-generated fixtures and check its stdout/stderr/exit code
// and the files it wrote - the same surface a caller of the plugin actually sees.
//
// Rotation is checked against ffmpeg's own autorotate output, decoded to raw pixels:
// dimensions alone cannot tell a 90 clockwise turn from a 90 counter-clockwise one,
// and getting that backwards produces an upside-down frame of exactly the right size.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/watch.mjs', import.meta.url));
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

let root;
let plain; // small landscape clip, no rotation
let rotatedMp4; // 640x360 carrying a Display Matrix - the real-world phone/screen case
let rotatedMkv; // same idea via the legacy "rotate" stream tag (matroska keeps it as ROTATE)
let scenes; // three visually distinct segments -> two real cuts
let six; // six equal one-second segments -> five cuts at 1s..5s, evenly spaced
let tail; // last cut one frame before the end -> a run-out gap only one frame wide
let hd; // 1920x1080, the size the vision docs' own resize table starts from
let grain; // 1920x1080 noise: a frame that encodes past Claude Code's 512000-byte Read budget

before(() => {
  root = mkdtempSync(join(tmpdir(), 'vw-test-'));

  plain = join(root, 'plain.mp4');
  run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', plain,
  ]);

  // -metadata rotate=90 is silently dropped by current ffmpeg's mp4 muxer, so the only
  // way to make a genuinely rotated mp4 is -display_rotation on the input, which writes
  // the tkhd display matrix exactly as a phone does
  const flat = join(root, 'flat.mp4');
  run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', flat,
  ]);
  rotatedMp4 = join(root, 'rotated.mp4');
  run(FFMPEG, ['-y', '-display_rotation', '90', '-i', flat, '-c', 'copy', rotatedMp4]);

  rotatedMkv = join(root, 'rotated.mkv');
  run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-metadata:s:v:0', 'rotate=90', rotatedMkv,
  ]);

  scenes = join(root, 'scenes.mp4');
  run(FFMPEG, [
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
    '-f', 'lavfi', '-i', 'smptebars=size=320x240:rate=10:duration=2',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=10:duration=2',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', scenes,
  ]);

  six = join(root, 'six.mp4');
  const colors = ['black', 'white', 'red', 'blue', 'green'];
  run(FFMPEG, [
    '-y',
    ...colors.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${c}:size=320x240:rate=10:duration=1`]),
    '-f', 'lavfi', '-i', 'smptebars=size=320x240:rate=10:duration=1',
    '-filter_complex', '[0:v][1:v][2:v][3:v][4:v][5:v]concat=n=6:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', six,
  ]);

  // 1.0s + 0.9s + 0.1s at 10fps: cuts at 1.0s and 1.9s, so the stretch after the last
  // cut holds exactly one frame - the case where a fill lands past the end of the clip
  tail = join(root, 'tail.mp4');
  run(FFMPEG, [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=red:size=320x240:rate=10:duration=1',
    '-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=10:duration=0.9',
    '-f', 'lavfi', '-i', 'color=c=white:size=320x240:rate=10:duration=0.1',
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]', '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', tail,
  ]);

  hd = join(root, 'hd.mp4');
  run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=5:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', hd,
  ]);

  grain = join(root, 'grain.mp4');
  run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=5:duration=1,noise=alls=60:allf=t',
    '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', grain,
  ]);
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function run(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed:\n${r.stderr}`);
  }
  return r;
}

function watch(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function watchJson(args) {
  const r = watch([...args, '--json']);
  assert.equal(r.status, 0, `expected success, got stderr:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

function jpgSize(file) {
  const r = run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', file,
  ]);
  const [w, h] = r.stdout.trim().split(',').map(Number);
  return `${w}x${h}`;
}

// decoded pixels, not the jpeg bytes: two encoders reaching the same image is the claim
function pixelHash(file) {
  const r = spawnSync(
    FFMPEG,
    ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 28 },
  );
  assert.equal(r.status, 0, `could not decode ${file}`);
  return createHash('sha1').update(r.stdout).digest('hex');
}

let seq = 0;
function outDir() {
  return join(root, `out${seq++}`);
}

/* ---------- --out guard rails ---------- */

test('refuses a non-empty --out without --force', () => {
  const dir = outDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stray.txt'), 'not ours');
  const r = watch([plain, '--out', dir, '--n', '2']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /already exists and is not empty/);
  assert.match(r.stderr, /Refusing to delete/);
  // must not have touched the directory it refused to touch
  assert.deepEqual(readdirSync(dir), ['stray.txt']);
});

test('--force overwrites a populated --out', () => {
  const dir = outDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stray.txt'), 'not ours');
  const r = watch([plain, '--out', dir, '--n', '2', '--force']);
  assert.equal(r.status, 0, r.stderr);
  const entries = readdirSync(dir);
  assert.ok(!entries.includes('stray.txt'), 'old contents should be gone');
  assert.ok(entries.some((f) => f.endsWith('.jpg')), 'new frames should be written');
});

test('--out pointing at a file is refused cleanly, not a stack trace', () => {
  const file = outDir();
  writeFileSync(file, 'i am a file, not a directory');
  const r = watch([plain, '--out', file, '--n', '2']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /exists and is not a directory/);
  assert.ok(!r.stderr.includes('at Object'), 'should not leak a raw node stack trace');
});

/* ---------- label colon escaping ---------- */

test('--label survives timestamps containing colons (drawtext escaping)', () => {
  const dir = outDir();
  const r = watch([plain, '--out', dir, '--n', '2', '--label', '--json']);
  assert.equal(r.status, 0, r.stderr);
  // stamp() always formats as mm:ss.s, so every label ffmpeg draws contains a
  // literal ':' - if escapeDrawtext regresses, ffmpeg's filtergraph parser fails
  // on it and the script drops back to unlabeled frames with a warning
  assert.ok(!/label extract failed/.test(r.stderr), r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.labels, true);
  assert.equal(report.frames.length, 2);
  // a drawn label must actually change the image, or "labels: true" means nothing
  const unlabeled = watchJson([plain, '--out', outDir(), '--n', '2']);
  assert.notEqual(pixelHash(report.frames[0].file), pixelHash(unlabeled.frames[0].file));
});

/* ---------- frame-count capping ---------- */

test('caps --n to the distinct frames available and delivers exactly that many', () => {
  const dir = outDir();
  // 2s at 10fps = 20 distinct frames; asking for 500 must be capped, not spawn 500 extracts
  const r = watch([plain, '--out', dir, '--n', '500', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const capped = r.stderr.match(/exceeds the ~(\d+) distinct frames available/);
  assert.ok(capped, 'expected the cap to be announced, got: ' + r.stderr);
  const announced = Number(capped[1]);
  const report = JSON.parse(r.stdout);
  // The cap announced 20 and used to hand back 19: the last evenly spaced sample of a
  // 2s 10fps clip is 1.95s, half a frame past the final frame at 1.9s, and -ss rounds
  // FORWARD - so it decoded nothing at all and the frame silently never appeared.
  assert.equal(report.frames.length, announced, 'announced frames must be the frames delivered');
  // and they must be that many DIFFERENT pictures: padding the count by re-extracting
  // the frame next door would satisfy the number while breaking what it promises
  const hashes = new Set(report.frames.map((f) => pixelHash(f.file)));
  assert.equal(hashes.size, announced, 'the capped frames must all be distinct pictures');
});

/* ---------- contact sheets ---------- */

test('an explicit 0 in the --sheet spec is not read as the 3 default', () => {
  const report = watchJson([six, '--out', outDir(), '--n', '4', '--sheet', '0x2']);
  // 0 columns is meaningless so it clamps to 1; what it must NOT do is fall through
  // `parseInt(v) || 3` and quietly build the 3-wide sheets nobody asked for
  assert.ok(report.sheets.length, 'no sheets were built');
  assert.equal(report.sheets[0].cols, 1);
  assert.equal(report.sheets[0].rows, 2);
  assert.equal(report.sheets.length, 2, '4 frames at 2 per sheet is 2 sheets');
});

test('a --sheet spec with no "x" still builds sheets instead of silently building none', () => {
  const report = watchJson([six, '--out', outDir(), '--n', '4', '--sheet', '4']);
  // rows came back undefined, so frames-per-sheet was NaN, the sheet loop's `s * per <
  // frames.length` was false on the first pass, and the run produced no sheets at all
  // without a word about why
  assert.ok(report.sheets.length, 'no sheets were built');
  assert.equal(report.sheets[0].cols, 4);
});

/* ---------- range validation ---------- */

test('rejects --from >= --to', () => {
  const r = watch([plain, '--from', '1.5', '--to', '1.5', '--out', outDir()]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--from\/--to must satisfy/);
});

test('an explicit --to 0 is validated, not silently treated as "unset"', () => {
  // if --to 0 were read as "absent" it would fall back to the full duration and
  // succeed; it must instead be honored as a real 0 and fail the from<to check
  const r = watch([plain, '--to', '0', '--out', outDir()]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--from\/--to must satisfy/);
});

/* ---------- item 3: hh:mm:ss / mm:ss parsing ---------- */

test('--from/--to read mm:ss as minutes and seconds, not as bare leading digits', () => {
  // parseFloat("0:02") is 2's worth of nothing - it reads 0 - so the old code sampled
  // the opening of the clip while claiming the window the caller asked for
  const clock = watchJson([scenes, '--from', '0:02', '--to', '0:05', '--n', '3', '--out', outDir()]);
  const secs = watchJson([scenes, '--from', '2', '--to', '5', '--n', '3', '--out', outDir()]);
  assert.deepEqual(clock.frames.map((f) => f.t), secs.frames.map((f) => f.t));
  for (const f of clock.frames) assert.ok(f.t >= 2 && f.t <= 5, `t=${f.t} outside [2,5]`);
  assert.ok(clock.frames[0].t > 2, 'window must start at 2s, not at the head of the clip');
});

test('--from/--to read hh:mm:ss', () => {
  const hms = watchJson([scenes, '--from', '00:00:02', '--to', '00:00:05', '--n', '3', '--out', outDir()]);
  const secs = watchJson([scenes, '--from', '2', '--to', '5', '--n', '3', '--out', outDir()]);
  assert.deepEqual(hms.frames.map((f) => f.t), secs.frames.map((f) => f.t));
});

test('a time that is not a time at all is refused, not quietly replaced by a default', () => {
  // falling back to the default here would sample a different window than the caller
  // asked for and say nothing - the same silent wrongness "--from 1:30" used to cause
  const r = watch([plain, '--from', 'later', '--out', outDir(), '--n', '2']);
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /--from is not a time/);
  // a flag whose value is missing entirely must not be read as 0 either - the flag
  // parser now refuses it before the time parser sees it, with the more specific message
  const r2 = watch([plain, '--to', '--json', '--out', outDir(), '--n', '2']);
  assert.equal(r2.status, 2, r2.stdout);
  assert.match(r2.stderr, /--to needs a value/);
});

test('an explicit --threshold 0 is honored, not read as "use the 0.3 default"', () => {
  // threshold 0 means "every frame differs enough to be a cut": scene detection then
  // returns far more candidates than frames asked for, so the run is nearly all cuts.
  // At the 0.3 default the same clip has only its two real cuts and the rest is fill -
  // if the explicit 0 were swallowed the two runs would be indistinguishable.
  const zero = watchJson([scenes, '--mode', 'scene', '--threshold', '0', '--n', '8', '--out', outDir()]);
  assert.equal(zero.mode, 'scene');
  assert.deepEqual(zero.sceneStats, { cuts: 7, fill: 1 });
  const dflt = watchJson([scenes, '--mode', 'scene', '--n', '8', '--out', outDir()]);
  assert.deepEqual(dflt.sceneStats, { cuts: 2, fill: 6 });
});

/* ---------- item 2: scene mode tops up to --n ---------- */

test('scene mode keeps every cut and fills the remainder from the largest gaps', () => {
  const report = watchJson([scenes, '--mode', 'scene', '--n', '8', '--out', outDir()]);
  assert.equal(report.mode, 'scene');
  assert.ok(report.sceneStats, 'manifest must report cuts vs fill honestly');
  assert.equal(report.frames.length, 8, 'scene mode must top up to --n, not stop at the cut count');
  assert.equal(report.sceneStats.cuts + report.sceneStats.fill, report.frames.length);
  assert.equal(report.sceneStats.cuts, 2, 'this fixture has exactly two cuts');
  assert.equal(report.sceneStats.fill, 6);
  // the whole point of the fill: no long stretch of the clip goes unsampled
  const ts = report.frames.map((f) => f.t);
  const worstGap = Math.max(...ts.slice(1).map((t, i) => t - ts[i]));
  assert.ok(worstGap < 1.5, `largest unsampled stretch was ${worstGap}s`);
});

test('fill never overspends its budget and never pushes a real cut out of the manifest', () => {
  // six equal segments = five cuts and six equal gaps. Rounding each gap's share
  // independently gives every gap one fill (0.5 rounds up) for a budget of three,
  // and the surplus used to be sliced off the end - dropping the 4s and 5s cuts while
  // the manifest still counted them.
  const report = watchJson([six, '--mode', 'scene', '--n', '8', '--out', outDir()]);
  assert.equal(report.mode, 'scene');
  assert.equal(report.frames.length, 8);
  assert.deepEqual(report.sceneStats, { cuts: 5, fill: 3 });
  const ts = report.frames.map((f) => f.t);
  for (const cut of [1, 2, 3, 4, 5]) {
    assert.ok(ts.some((t) => Math.abs(t - cut) < 0.15), `cut near ${cut}s missing from ${ts}`);
  }
});

test('scene mode with more cuts than --n still shows the opening scene', () => {
  const report = watchJson([six, '--mode', 'scene', '--n', '3', '--out', outDir()]);
  assert.equal(report.frames.length, 3);
  // a detected cut is the FIRST frame of the scene AFTER it, so a run of nothing but
  // cuts never shows scene 1 at all. One sample goes to the run-in, and the manifest
  // counts it as fill rather than passing it off as a cut.
  assert.deepEqual(report.sceneStats, { cuts: 2, fill: 1 });
  assert.ok(report.frames[0].t < 1, `nothing sampled before the first cut at 1s: ${report.frames[0].t}`);
});

test('a fill landing in the clip\'s final frame is still delivered', () => {
  // tail.mp4's last cut is at 1.9s of a 2.0s 10fps clip, so the run-out gap is one frame
  // wide and its midpoint (1.95s) is past the last frame - where -ss decodes nothing at
  // all, and the frame the manifest budgeted for simply never arrived
  const report = watchJson([tail, '--mode', 'scene', '--n', '16', '--out', outDir()]);
  assert.equal(report.frames.length, 16, 'a budgeted fill went missing');
  assert.equal(report.sceneStats.cuts + report.sceneStats.fill, 16);
});

test('manifest tells the truth when scene mode falls back to grid', () => {
  // plain.mp4 is one unchanging pattern - no cuts to find
  const r = watch([plain, '--mode', 'scene', '--n', '3', '--out', outDir(), '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /falling back to grid/);
  const report = JSON.parse(r.stdout);
  assert.equal(report.mode, 'grid');
  assert.equal(report.sceneStats, undefined);
});

/* ---------- item 1: display-rotation handling ---------- */

test('an unrotated clip reports its coded size with no rotation', () => {
  const report = watchJson([plain, '--n', '2', '--out', outDir()]);
  assert.equal(report.size, '320x240');
  assert.equal(report.rotation, undefined);
  assert.equal(report.codedSize, undefined);
  assert.equal(jpgSize(report.frames[0].file), '320x240');
});

test('a Display Matrix clip is scaled on its display long edge, not its coded one', () => {
  const report = watchJson([rotatedMp4, '--n', '1', '--width', '320', '--out', outDir()]);
  // coded 640x360; the display matrix turns it into a 360x640 portrait frame
  assert.equal(report.codedSize, '640x360');
  assert.equal(report.size, '360x640');
  assert.equal(report.rotation, 270); // clockwise turn applied, ffprobe reports it as +90
  // --width names the LONG edge: 640 -> 320 means 180x320. Reading the clip as landscape
  // instead gives 320x180 - the same long edge on the wrong axis, which for a real 1080p
  // phone clip is the ~3.2x-too-many-pixels frame this item exists to stop.
  assert.equal(jpgSize(report.frames[0].file), '180x320');
});

test('a Display Matrix clip comes out the same way ffmpeg autorotate would turn it', () => {
  const report = watchJson([rotatedMp4, '--n', '1', '--width', '320', '--out', outDir()]);
  const t = report.frames[0].t;
  const truth = join(root, `truth${seq++}.jpg`);
  // ffmpeg's own autorotate is the reference: same seek, same scale, same encoder settings
  run(FFMPEG, [
    '-v', 'error', '-y', '-ss', String(t), '-i', rotatedMp4,
    '-frames:v', '1', '-vf', 'scale=-2:320', '-q:v', '3', truth,
  ]);
  assert.equal(
    pixelHash(report.frames[0].file),
    pixelHash(truth),
    'frame differs from ffmpeg autorotate - the transpose direction is wrong',
  );
});

test('the legacy rotate stream tag is honored too', () => {
  // matroska keeps it as a literal ROTATE tag and ffmpeg does NOT autorotate on it,
  // so this branch is the one case where the script must turn the frame itself
  const report = watchJson([rotatedMkv, '--n', '1', '--width', '320', '--out', outDir()]);
  assert.equal(report.codedSize, '640x360');
  assert.equal(report.size, '360x640');
  assert.equal(report.rotation, 90);
  assert.equal(jpgSize(report.frames[0].file), '180x320');
});

test('the legacy rotate tag turns the frame clockwise, not merely to the right size', () => {
  // There is no autorotate reference for this branch: ffmpeg does NOT autorotate on a
  // matroska ROTATE tag (decode rotated.mkv yourself and it comes out 640x360), which is
  // exactly why the script has to turn the frame itself. And 180x320 is 180x320 whichever
  // way the turn went, so the dimension check above cannot catch a flipped sign.
  // rotate=90 is defined as "turn 90 degrees clockwise to display", so a hand-written
  // transpose=1 is the reference; transpose=2 is the wrong answer this must reject.
  const report = watchJson([rotatedMkv, '--n', '1', '--width', '320', '--out', outDir()]);
  const at = String(report.frames[0].t);
  const turn = (dir) => {
    const f = join(root, `turn${seq++}.jpg`);
    run(FFMPEG, ['-v', 'error', '-y', '-ss', at, '-i', rotatedMkv, '-frames:v', '1',
      '-vf', `transpose=${dir},scale=-2:320`, '-q:v', '3', f]);
    return pixelHash(f);
  };
  const clockwise = turn(1);
  // the oracle only means something if the two directions actually differ on this clip
  assert.notEqual(clockwise, turn(2), 'fixture is rotationally symmetric - useless as proof');
  assert.equal(pixelHash(report.frames[0].file), clockwise, 'frame was turned the wrong way');
});

test('the human-readable header says the frames were rotated', () => {
  const r = watch([rotatedMp4, '--n', '1', '--width', '320', '--out', outDir()]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /360x640/);
  assert.match(r.stdout, /rotated 270 clockwise from 640x360/);
});

/* ---------- --dry-run and valueless flags ---------- */

test('--dry-run picks the same timestamps as the real run and writes nothing', () => {
  const dry = outDir();
  const plan = watchJson([plain, '--n', '5', '--dry-run', '--out', dry]);
  assert.equal(plan.dryRun, true);
  assert.ok(!existsSync(dry), '--out must not be created on a dry run');
  assert.ok(plan.ffmpeg && plan.ffprobe, 'the binaries it found are part of the plan');
  assert.equal(plan.times.length, 5);
  // the first frame's argv is the real one: seek to the first timestamp, one frame, into --out
  assert.ok(plan.argv.includes('-ss') && plan.argv.includes(String(plan.times[0])), plan.argv.join(' '));
  assert.ok(plan.argv.some((a) => a.endsWith('f001.jpg')));
  const real = watchJson([plain, '--n', '5', '--out', outDir()]);
  assert.deepEqual(plan.times, real.frames.map((f) => f.t));
  assert.equal(plan.mode, real.mode);
  // the human-readable form says so too, and does not claim frames it did not write
  const r = watch([plain, '--n', '3', '--dry-run', '--out', dry]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dry run: 3 frames \[grid\]/);
  assert.match(r.stdout, /not created/);
  assert.ok(!existsSync(dry));
});

test('a trailing --out or --mode with no value is refused, not read as "true"', () => {
  for (const name of ['out', 'mode', 'width', 'tokens', 'n', 'from', 'to', 'threshold']) {
    const r = watch([plain, '--' + name]);
    assert.equal(r.status, 2, name);
    assert.match(r.stderr, new RegExp('--' + name + ' needs a value'));
  }
  assert.ok(!existsSync(join(process.cwd(), 'true')), 'no directory named true in the cwd');
  // a valueless --out ahead of another flag is the same mistake
  const r = watch([plain, '--out', '--n', '2']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--out needs a value/);
  // --sheet keeps its bare form: it has a documented default
  const ok = watchJson([plain, '--n', '2', '--sheet', '--out', outDir()]);
  assert.equal(ok.sheets.length, 1);
});

test("a value that is not a number is refused, not replaced by the default", () => {
  // --n ten used to become 24 and --width 1080p the default size, with no word said
  for (const [name, value] of [["n", "ten"], ["width", "1080p"], ["tokens", "lots"], ["threshold", "high"]]) {
    const r = watch([plain, "--" + name, value, "--out", outDir()]);
    assert.equal(r.status, 2, name);
    assert.match(r.stderr, new RegExp("--" + name + " must be a number"));
  }
});

test("an unknown --mode is refused instead of quietly running grid", () => {
  const r = watch([plain, "--mode", "scenes", "--n", "2", "--out", outDir()]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--mode must be grid or scene \(got scenes\)/);
});

/* ---------- sizing to Claude's vision budget ---------- */

// Anthropic's rule (platform.claude.com/docs/en/build-with-claude/vision): one visual
// token per 28x28 patch; the standard tier resizes past a 1568px edge or 1568 tokens
const tokensOf = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);
const dims = (s) => s.split("x").map(Number);
function assertFitsStandardTier(size, what) {
  const [w, h] = dims(size);
  assert.ok(Math.ceil(w / 28) * 28 <= 1568 && Math.ceil(h / 28) * 28 <= 1568, what + " edge over 1568: " + size);
  assert.ok(tokensOf(w, h) <= 1568, what + " costs " + tokensOf(w, h) + " tokens, over 1568: " + size);
}

test("the default frame is the largest size the standard tier takes without resizing", () => {
  const report = watchJson([hd, "--n", "1", "--out", outDir()]);
  // the docs' own table: 1920x1080 on the standard tier is resized to 1456x819 (1560
  // tokens); 819 is odd, and an even frame one row shorter costs the same 1560
  assert.equal(report.frameSize, "1456x818");
  assert.equal(report.tokensPerFrame, 1560);
  assert.equal(jpgSize(report.frames[0].file), report.frameSize, "the manifest must state the real size");
  assertFitsStandardTier(report.frameSize, "frame");
});

test("--tokens raises the budget for a high-resolution-tier model", () => {
  // 1920x1080 fits the 4784-token tier as it is (2691 tokens, per the docs table)
  const report = watchJson([hd, "--n", "1", "--tokens", "4784", "--out", outDir()]);
  assert.equal(report.frameSize, "1920x1080");
  assert.equal(report.tokensPerFrame, 2691);
  assert.equal(jpgSize(report.frames[0].file), "1920x1080");
});

test("--tokens past 4784 is clamped to it, with a word, not spent on pixels that are thrown away", () => {
  const r = watch([hd, "--n", "1", "--tokens", "9000", "--dry-run", "--json", "--out", outDir()]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /--tokens 9000 is over 4784/);
  const plan = JSON.parse(r.stdout);
  assert.ok(plan.tokensPerFrame <= 4784, "frame costs " + plan.tokensPerFrame);
});

test("--width alone keeps its meaning: the long edge, never upscaled", () => {
  const report = watchJson([hd, "--n", "1", "--width", "960", "--out", outDir()]);
  assert.equal(report.frameSize, "960x540");
  assert.equal(jpgSize(report.frames[0].file), "960x540");
  const small = watchJson([plain, "--n", "1", "--width", "4000", "--out", outDir()]);
  assert.equal(jpgSize(small.frames[0].file), "320x240");
});

test("a contact sheet is sized to the same budget as a frame, margins included", () => {
  // a 3x3 sheet of 960px frames used to come out 1944px wide - past the 1568 edge, so the
  // API resampled it and the extra pixels were paid for in bytes and thrown away
  const report = watchJson([hd, "--n", "9", "--sheet", "3x3", "--out", outDir()]);
  assert.equal(report.sheets.length, 1);
  const s = report.sheets[0];
  assert.equal(jpgSize(s.file), s.size, "the manifest must state the real sheet size");
  assert.equal(s.tokens, tokensOf(...dims(s.size)));
  assertFitsStandardTier(s.size, "sheet");
  // and it spends the budget rather than leaving most of it unused
  assert.ok(s.tokens > 1400, "sheet only uses " + s.tokens + " of 1568 tokens");
});

test("the last sheet drops the rows it has no frames for", () => {
  // 4 frames at 3x3 used to be a sheet one third empty tiles, priced as a full sheet
  const report = watchJson([hd, "--n", "4", "--sheet", "3x3", "--out", outDir()]);
  assert.equal(report.sheets.length, 1);
  assert.equal(report.sheets[0].cols, 3);
  assert.equal(report.sheets[0].rows, 2);
  assert.equal(jpgSize(report.sheets[0].file), report.sheets[0].size);
  assertFitsStandardTier(report.sheets[0].size, "sheet");
});

test("a portrait clip's sheet keeps portrait tiles and still fits the budget", () => {
  const report = watchJson([rotatedMp4, "--n", "4", "--sheet", "2x2", "--out", outDir()]);
  const s = report.sheets[0];
  assert.equal(jpgSize(s.file), s.size);
  assertFitsStandardTier(s.size, "sheet");
  const [w, h] = dims(s.size);
  assert.ok(h > w, "2x2 portrait tiles make a portrait sheet, got " + s.size);
});

test("a frame over Claude Code's 512000-byte Read budget is re-encoded once, from the source", () => {
  // Claude Code 2.1.282's Read re-encodes any image over 512000 bytes - a second lossy
  // pass. Grain encodes past that at -q:v 3, so the frame is re-extracted coarser instead.
  const r = watch([grain, "--n", "2", "--out", outDir(), "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.match(r.stderr, /re-encoded from the source at -q:v \d+/);
  for (const f of report.frames) {
    assert.ok(statSync(f.file).size <= 512000, f.file + " is " + statSync(f.file).size + " bytes");
    assert.ok(f.q > 3, "the manifest must say the frame was re-encoded");
  }
  // an ordinary frame is untouched and carries no q
  const plainReport = watchJson([hd, "--n", "1", "--out", outDir()]);
  assert.equal(plainReport.frames[0].q, undefined);
});

test("--dry-run states the frame size and its token cost", () => {
  const plan = watchJson([hd, "--n", "2", "--dry-run", "--out", outDir()]);
  assert.equal(plan.frameSize, "1456x818");
  assert.equal(plan.tokensPerFrame, 1560);
});
