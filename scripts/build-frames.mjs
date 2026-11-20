import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const NOEUL = path.resolve(ROOT, opt('--noeul', process.env.NOEUL_DIR || '../Drawing/noeul'));
const OUT = path.resolve(ROOT, opt('--out', 'src/frames'));
const FORCE = flag('--force');
const SIZES = [{ w: 640, q: 70 }, { w: 1280, q: 78 }, { w: 1920, q: 80 }];
const SRC_W = 1920;
const SRC_H = 1080;

if (!fs.existsSync(path.join(NOEUL, 'noeul_cycle.js'))) {
  console.error('noeul_cycle.js not found in ' + NOEUL + ' (pass --noeul <dir> or set NOEUL_DIR)');
  process.exit(1);
}
if (spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('ffmpeg is not on PATH');
  process.exit(1);
}

const N = createRequire(import.meta.url)(path.join(NOEUL, 'noeul_cycle.js'));
const pad = (n) => String(n).padStart(2, '0');
const hex = (c) => '#' + c.map((v) => pad(Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16))).join('').toUpperCase();
const CYCLE = path.join(NOEUL, 'cycle');

if (flag('--render')) {
  console.log('painting missing sheets with render_cycle.js — this takes a while…');
  const r = spawnSync(process.execPath, ['render_cycle.js', 'missing'], { cwd: NOEUL, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
const frames = (fs.existsSync(CYCLE) ? fs.readdirSync(CYCLE) : [])
  .map((name) => /^noeul_(\d+)_(\d\d)(\d\d)\.png$/.exec(name))
  .filter(Boolean)
  .map((m) => ({ n: +m[1], label: m[2] + m[3], t: +m[2] + +m[3] / 60, png: path.join(CYCLE, m[0]) }))
  .sort((a, b) => a.t - b.t);
const step = 24 / frames.length;
const bad = frames.filter((f, i) => Math.abs(f.t - i * step) > 1e-6 || f.n !== i + 1);
if (!frames.length || bad.length) {
  console.error(frames.length
    ? `${CYCLE} should hold ${frames.length} sheets ${step * 60} min apart from 00:00, numbered 01..${frames.length}; out of step:\n  ` +
      bad.map((f) => path.basename(f.png)).join('\n  ') + '\n(render the gaps with `node render_cycle.js missing`, or pass --render)'
    : `no noeul_NN_HHMM.png sheets in ${CYCLE} (run \`node render_cycle.js\` there, or pass --render)`);
  process.exit(1);
}
console.log(`${frames.length} sheets, every ${step * 60} min`);

const run = (args) => new Promise((resolve, reject) => {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = [], err = [];
  p.stdout.on('data', (d) => out.push(d));
  p.stderr.on('data', (d) => err.push(d));
  p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString() || 'ffmpeg ' + code))));
});

const jobs = [];
const labels = new Set(frames.map((f) => f.label));
for (const s of SIZES) {
  const dir = path.join(OUT, String(s.w));
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.webp') && !labels.has(name.slice(0, -5))) fs.unlinkSync(path.join(dir, name));
  }
  for (const f of frames) {
    const dst = path.join(OUT, String(s.w), f.label + '.webp');
    const fresh = !FORCE && fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(f.png).mtimeMs;
    if (!fresh) jobs.push(() => run(['-y', '-i', f.png, '-vf', `scale=${s.w}:-2:flags=lanczos`, '-c:v', 'libwebp', '-quality', String(s.q), '-compression_level', '6', dst]));
  }
}
for (const f of frames) {
  jobs.push(async () => {
    const px = await run(['-i', f.png, '-vf', 'scale=1:12:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const band = (k) => [px[k * 3] / 255, px[k * 3 + 1] / 255, px[k * 3 + 2] / 255];
    const avg = [0, 1, 2].map((c) => px.filter((_, i) => i % 3 === c).reduce((a, v) => a + v, 0) / 12 / 255);
    Object.assign(f, { top: hex(band(0)), bottom: hex(band(11)), avg: hex(avg) });
  });
}

const t0 = Date.now();
let done = 0;
const total = jobs.length;
await Promise.all(Array.from({ length: Math.max(2, Math.min(12, os.cpus().length >> 1)) }, async () => {
  while (jobs.length) {
    await jobs.shift()();
    done++;
    if (process.stdout.isTTY) process.stdout.write(`\r${done}/${total}`);
  }
}));
if (process.stdout.isTTY) process.stdout.write('\r');

const manifest = {
  source: 'Drawing/noeul/noeul_cycle.js',
  width: SRC_W, height: SRC_H,
  step: step * 60,
  sizes: SIZES.map((s) => s.w),
  path: 'frames/{size}/{label}.webp',
  frames: frames.map((f) => {
    const K = N.keyAt(f.t);
    return { t: f.t, label: f.label, top: f.top, bottom: f.bottom, avg: f.avg, sky: [hex(K.sky[0]), hex(K.sky[7])] };
  }),
};
fs.writeFileSync(path.join(OUT, 'manifest.js'),
  'window.NOEUL_FRAMES = ' + JSON.stringify(manifest) + ';\n');

for (const s of SIZES) {
  const dir = path.join(OUT, String(s.w));
  const bytes = frames.reduce((a, f) => a + fs.statSync(path.join(dir, f.label + '.webp')).size, 0);
  console.log(`${String(s.w).padStart(4)}px  ${(bytes / 1048576).toFixed(1).padStart(5)} MB total, ${(bytes / frames.length / 1024).toFixed(0).padStart(3)} KB/frame`);
}
console.log(`${frames.length} frames → ${path.relative(ROOT, OUT)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
