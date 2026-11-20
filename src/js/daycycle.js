(function () {
  'use strict';

  const M = window.NOEUL_FRAMES;
  let canvas = document.getElementById('sky');
  const track = document.getElementById('day');
  if (!M || !canvas || !track) return;

  const q = new URLSearchParams(location.search);
  const N = M.frames.length;
  const IW = M.width, IH = M.height;
  const LO = M.sizes[0], HI_SIZES = M.sizes.slice(1);
  const START = parseFloat(q.get('start') ?? track.dataset.startHour ?? '0') || 0;
  const SOFT = (q.get('blend') || track.dataset.blend || 'grain') === 'fade' ? 0 : 0.45;
  const SNAP = (q.get('snap') ?? track.dataset.snap ?? '1') !== '0';
  const SNAP_IDLE = 1000;
  const FOCUS = [0.62, 0.5];
  const HI_KEEP = 8;
  const LO_KEEP = 24;
  const TEX_KEEP = 6;
  const PARALLEL = 3;
  const SMOOTH = 0.16;
  const JUMP = 2;
  const DEBUG = q.has('debug');
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

  const mod = (a, n) => ((a % n) + n) % n;
  const url = (size, i) => M.path.replace('{size}', size).replace('{label}', M.frames[i].label);
  const now = () => performance.now();

  const loSrc = new Array(N).fill(null);
  const lo = new Map();
  const hi = new Map();
  const pending = new Set(), failed = new Set(), decoding = new Set();
  let hiSize = HI_SIZES[HI_SIZES.length - 1];
  let cursor = 0, dir = 1, inflight = 0, bytes = 0;

  const viaFetch = /^https?:$/.test(location.protocol) && 'createImageBitmap' in window;
  function fetchSrc(src, urgent) {
    if (viaFetch) {
      return fetch(src, { priority: urgent ? 'high' : 'auto' })
        .then((r) => { if (!r.ok) throw new Error(r.status + ' ' + src); return r.blob(); })
        .then((b) => { bytes += b.size; return b; });
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => img.decode().then(() => resolve(img), () => resolve(img));
      img.onerror = () => reject(new Error(src));
      img.src = src;
    });
  }
  const decode = (src) => (src instanceof Blob ? createImageBitmap(src) : Promise.resolve(src));

  function load(size, i, urgent) {
    const key = size + ':' + i;
    pending.add(key);
    inflight++;
    fetchSrc(url(size, i), urgent)
      .then((src) => {
        if (size === LO) {
          loSrc[i] = src;
          if (loWindow().includes(i)) decodeLo(i);
          return;
        }
        return decode(src).then((pic) => {
          const old = hi.get(i);
          if (old && old.pic.close) old.pic.close();
          hi.set(i, { pic, size, used: now() });
          trimHi();
          frameArrived(i);
        });
      })
      .catch((e) => { failed.add(key); console.warn('daycycle:', e.message); })
      .then(() => { pending.delete(key); inflight--; pump(); });
  }

  function decodeLo(i) {
    if (lo.has(i) || decoding.has(i) || !loSrc[i]) return;
    decoding.add(i);
    decode(loSrc[i])
      .then((pic) => { lo.set(i, { pic, used: now() }); trimLo(); frameArrived(i); },
        (e) => console.warn('daycycle: preview', i, e.message))
      .then(() => decoding.delete(i));
  }

  const hasHi = (i) => hi.has(i) && hi.get(i).size >= hiSize;
  const free = (size, i) => !pending.has(size + ':' + i) && !failed.has(size + ':' + i);
  function hiWindow() {
    const a = cursor;
    const w = dir >= 0 ? [a, a + 1, a + 2, a + 3, a + 4, a - 1] : [a + 1, a, a - 1, a - 2, a - 3, a + 2];
    return w.map((i) => mod(i, N));
  }
  function loWindow() {
    const out = [];
    for (let d = -3; d <= 8; d++) out.push(mod(cursor + d * dir, N));
    return out;
  }
  function nextJob() {
    const a = cursor, b = mod(cursor + 1, N);
    for (const i of [a, b]) if (!loSrc[i] && !hasHi(i) && free(LO, i)) return [LO, i, true];
    for (const i of hiWindow()) if (!hasHi(i) && free(hiSize, i)) return [hiSize, i, i === a || i === b];
    for (let d = 1; d < N; d++) {
      for (const i of [mod(a + d * dir, N), mod(a - d * dir, N)]) if (!loSrc[i] && free(LO, i)) return [LO, i, false];
    }
    return null;
  }
  function pump() {
    while (inflight < PARALLEL) {
      const job = nextJob();
      if (!job) return;
      load(job[0], job[1], job[2]);
    }
  }
  function trimHi() {
    if (hi.size <= HI_KEEP) return;
    const keep = new Set(hiWindow());
    const old = [...hi.entries()].filter(([i]) => !keep.has(i)).sort((x, y) => x[1].used - y[1].used);
    while (hi.size > HI_KEEP && old.length) {
      const [i, e] = old.shift();
      if (e.pic.close) e.pic.close();
      hi.delete(i);
    }
  }
  function trimLo() {
    if (lo.size <= LO_KEEP) return;
    const keep = new Set(loWindow());
    const old = [...lo.entries()].filter(([i]) => !keep.has(i)).sort((x, y) => x[1].used - y[1].used);
    while (lo.size > LO_KEEP && old.length) {
      const [i, e] = old.shift();
      if (e.pic.close) e.pic.close();
      lo.delete(i);
    }
  }
  function best(i) {
    const h = hi.get(i);
    if (h) { h.used = now(); return { pic: h.pic, key: i + '@' + h.size }; }
    const l = lo.get(i);
    if (l) { l.used = now(); return { pic: l.pic, key: i + '@' + LO }; }
    decodeLo(i);
    return null;
  }

  const VS = 'attribute vec2 p; varying vec2 v;' +
    'void main(){ v = vec2(p.x, -p.y) * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }';
  const FS = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH', 'precision highp float;', '#else', 'precision mediump float;', '#endif',
    'uniform sampler2D uA, uB;',
    'uniform vec4 uCrop;',
    'uniform vec2 uPaper;',
    'uniform float uMix, uSoft;',
    'varying vec2 v;',
    'float h(vec2 p){ vec3 q = fract(p.xyx * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }',
    'float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(h(i), h(i + vec2(1.0, 0.0)), f.x), mix(h(i + vec2(0.0, 1.0)), h(i + vec2(1.0, 1.0)), f.x), f.y); }',
    'float fbm(vec2 p){ float s = 0.0, a = 0.5; mat2 r = mat2(0.8, -0.6, 0.6, 0.8);',
    '  for (int i = 0; i < 4; i++) { s += a * n(p); p = r * p * 2.03 + 17.0; a *= 0.5; } return s / 0.9375; }',
    'void main(){',
    '  vec2 uv = uCrop.zw + v * uCrop.xy;',
    '  vec3 a = texture2D(uA, uv).rgb, b = texture2D(uB, uv).rgb;',
    '  float m = uMix;',
    '  if (uSoft > 0.0) {',
    '    vec2 pp = uv * uPaper;',
    '    vec2 w = vec2(fbm(pp / 160.0 + 3.1), fbm(pp / 160.0 - 7.7));',
    '    float g = 0.6 * clamp((fbm(pp / 110.0 + w * 2.5) - 0.5) * 1.8 + 0.5, 0.0, 1.0) + 0.4 * h(floor(pp / 1.6));',
    '    m = smoothstep(0.0, 1.0, (uMix * (1.0 + uSoft) - g) / uSoft);',
    '  }',
    '  gl_FragColor = vec4(mix(a, b, m), 1.0);',
    '}',
  ].join('\n');

  function makeGL(cv) {
    const gl = cv.getContext('webgl', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'low-power',
    });
    if (!gl) return null;
    const tex = new Map();
    let prog, U, lost = false;

    function init() {
      const sh = (type, src) => {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(prog));
      gl.useProgram(prog);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'p');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      U = {};
      for (const k of ['uA', 'uB', 'uCrop', 'uPaper', 'uMix', 'uSoft']) U[k] = gl.getUniformLocation(prog, k);
      gl.uniform1i(U.uA, 0);
      gl.uniform1i(U.uB, 1);
      gl.uniform2f(U.uPaper, IW, IH);
      gl.uniform1f(U.uSoft, SOFT);
      tex.clear();
    }

    function texture(src, unit, inUse) {
      let e = tex.get(src.key);
      gl.activeTexture(gl.TEXTURE0 + unit);
      if (e && e.pic === src.pic) { e.used = now(); gl.bindTexture(gl.TEXTURE_2D, e.t); return; }
      if (!e) {
        e = { t: gl.createTexture() };
        tex.set(src.key, e);
        gl.bindTexture(gl.TEXTURE_2D, e.t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      } else gl.bindTexture(gl.TEXTURE_2D, e.t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.pic);
      e.pic = src.pic;
      e.used = now();
      if (tex.size > TEX_KEEP) {
        const old = [...tex.entries()].filter(([k]) => !inUse.includes(k)).sort((x, y) => x[1].used - y[1].used);
        while (tex.size > TEX_KEEP && old.length) { const [k, o] = old.shift(); gl.deleteTexture(o.t); tex.delete(k); }
      }
    }

    cv.addEventListener('webglcontextlost', (ev) => { ev.preventDefault(); lost = true; });
    cv.addEventListener('webglcontextrestored', () => { lost = false; init(); redraw(); });
    init();

    return {
      kind: 'webgl',
      get textures() { return tex.size; },
      resize(w, h) {
        if (cv.width === w && cv.height === h) return;
        cv.width = w; cv.height = h; gl.viewport(0, 0, w, h);
      },
      draw(A, B, mix, crop) {
        if (lost) return;
        const inUse = [A.key, B.key];
        texture(A, 0, inUse);
        texture(B, 1, inUse);
        gl.uniform4f(U.uCrop, crop[0], crop[1], crop[2], crop[3]);
        gl.uniform1f(U.uMix, mix);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      },
    };
  }

  function make2D(cv) {
    const ctx = cv.getContext('2d', { alpha: false });
    const put = (src, alpha, crop) => {
      const iw = src.pic.naturalWidth || src.pic.width, ih = src.pic.naturalHeight || src.pic.height;
      ctx.globalAlpha = alpha;
      ctx.drawImage(src.pic, crop[2] * iw, crop[3] * ih, crop[0] * iw, crop[1] * ih, 0, 0, cv.width, cv.height);
    };
    return {
      kind: '2d',
      textures: 0,
      resize(w, h) {
        if (cv.width === w && cv.height === h) return;
        cv.width = w; cv.height = h; ctx.imageSmoothingQuality = 'medium';
      },
      draw(A, B, mix, crop) {
        put(A, 1, crop);
        if (mix > 0.002 && B.pic !== A.pic) put(B, mix, crop);
      },
    };
  }

  let renderer;
  if (q.get('renderer') !== '2d') {
    try { renderer = makeGL(canvas); } catch (e) { console.warn('daycycle: WebGL unavailable,', e.message); }
  }
  if (!renderer) renderer = make2D(canvas);

  function fallback2D(err) {
    console.warn('daycycle: using canvas 2D,', err.message);
    const cv = canvas.cloneNode(false);
    canvas.replaceWith(cv);
    canvas = cv;
    renderer = make2D(canvas);
    layout();
  }

  let crop = [1, 1, 0, 0], trackTop = 0, hourPx = 1, days = 1;

  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;top:0;left:0;width:0;height:var(--hour);visibility:hidden;pointer-events:none';
  document.body.appendChild(probe);

  const DAYS_KEY = 'daycycle:days';
  function setDays(d) {
    days = d;
    track.style.setProperty('--days', d);
    try { sessionStorage.setItem(DAYS_KEY, d); } catch (e) {}
  }
  try { const d = parseInt(sessionStorage.getItem(DAYS_KEY), 10); if (d > 1) setDays(d); } catch (e) {}

  function grow() {
    const need = Math.floor(Math.max(0, scrollY - trackTop) / (hourPx * 24)) + 2;
    if (need > days) setDays(need);
  }

  function layout() {
    const cw = canvas.clientWidth || innerWidth, ch = canvas.clientHeight || innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const va = cw / ch, ia = IW / IH;
    const sx = va < ia ? va / ia : 1, sy = va > ia ? ia / va : 1;
    crop = [sx, sy, (1 - sx) * FOCUS[0], (1 - sy) * FOCUS[1]];
    const need = (cw * dpr) / sx;
    hiSize = HI_SIZES.find((s) => s >= need * 0.9) || HI_SIZES[HI_SIZES.length - 1];
    const k = Math.min(1, (hiSize * sx) / (cw * dpr));
    renderer.resize(Math.max(1, Math.round(cw * dpr * k)), Math.max(1, Math.round(ch * dpr * k)));
    trackTop = track.getBoundingClientRect().top + scrollY;
    hourPx = Math.max(1, probe.offsetHeight);
    grow();
    drawn = '';
  }

  const hourAtScroll = () => START + Math.max(0, scrollY - trackTop) / hourPx;

  let target = 0, shown = 0, raf = 0, last = 0, dirty = true, drawn = '';
  const meta = document.querySelector('meta[name="theme-color"]');
  const stats = { paints: 0, ms: 0 };

  function kick() {
    if (!raf) { last = now(); raf = requestAnimationFrame(tick); }
  }
  function redraw() { drawn = ''; dirty = true; kick(); }

  let snapTimer = 0, touching = false;
  function armSnap() {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(snap, SNAP_IDLE);
  }
  function snap() {
    if (touching) return;
    const step = 24 / N;
    const h = Math.max(START, Math.round(hourAtScroll() / step) * step);
    const y = trackTop + (h - START) * hourPx;
    if (Math.abs(y - scrollY) <= 1) return;
    scrollTo({ top: y, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
  }
  function untouch(e) {
    touching = e.touches.length > 0;
    if (!touching) armSnap();
  }

  function onScroll() {
    if (SNAP) armSnap();
    grow();
    const t = hourAtScroll();
    if (t === target) return;
    dir = t > target ? 1 : -1;
    target = t;
    if (Math.abs(target - shown) > JUMP) shown = target;
    dirty = true;
    kick();
  }

  function tick(ts) {
    raf = 0;
    const dt = Math.min(0.1, (ts - last) / 1000);
    last = ts;
    if (shown !== target) {
      const k = reduceMotion.matches ? 1 : 1 - Math.exp(-dt / SMOOTH);
      shown += (target - shown) * k;
      if (Math.abs(target - shown) < 2e-4) shown = target;
      dirty = true;
    }
    if (dirty) paint();
    if (shown !== target) raf = requestAnimationFrame(tick);
  }

  function enter(i) {
    cursor = i;
    const f = M.frames[i];
    document.documentElement.style.backgroundColor = f.bottom;
    if (meta) meta.setAttribute('content', f.top);
    for (const k of loWindow()) decodeLo(k);
    trimHi();
    trimLo();
    pump();
  }

  function paint() {
    dirty = false;
    const f = mod(shown, 24) * (N / 24);
    const i = Math.floor(f) % N, j = (i + 1) % N;
    if (i !== cursor) enter(i);
    const A = best(i), B = best(j);
    if (!A && !B) return;
    const a = A || B, b = B || A, mix = A && B ? f - Math.floor(f) : A ? 0 : 1;
    const sig = a.key + '|' + b.key + '|' + mix.toFixed(4);
    if (sig === drawn) return;
    const t0 = now();
    try { renderer.draw(a, b, mix, crop); } catch (e) {
      if (renderer.kind === 'webgl' && e.name === 'SecurityError') { fallback2D(e); renderer.draw(a, b, mix, crop); } else throw e;
    }
    drawn = sig;
    stats.paints++;
    stats.ms += now() - t0;
  }

  function frameArrived(i) {
    if (i === cursor || i === mod(cursor + 1, N)) { dirty = true; kick(); }
  }

  layout();
  target = shown = hourAtScroll();
  enter(Math.floor(mod(shown, 24) * (N / 24)) % N);
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', () => { layout(); onScroll(); redraw(); });
  addEventListener('load', () => { layout(); onScroll(); });
  if (SNAP) {
    addEventListener('touchstart', () => { touching = true; clearTimeout(snapTimer); }, { passive: true });
    addEventListener('touchend', untouch, { passive: true });
    addEventListener('touchcancel', untouch, { passive: true });
  }

  if (DEBUG) {
    const hud = document.createElement('pre');
    hud.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:9;margin:0;padding:6px 8px;font:11px/1.35 ui-monospace,monospace;' +
      'color:#fff;background:rgba(0,0,0,.55);border-radius:4px;pointer-events:none;white-space:pre';
    document.body.appendChild(hud);
    window.daycycle = {
      stats, get renderer() { return renderer.kind; },
      at(h) { target = shown = h; drawn = ''; const t = now(); paint(); return now() - t; },
    };
    let p0 = 0, ms0 = 0, t0 = now();
    setInterval(() => {
      const t = now(), dtS = (t - t0) / 1000, h = mod(shown, 24);
      const fps = (stats.paints - p0) / dtS, avg = stats.paints > p0 ? (stats.ms - ms0) / (stats.paints - p0) : 0;
      p0 = stats.paints; ms0 = stats.ms; t0 = t;
      const A = best(cursor), B = best(mod(cursor + 1, N));
      hud.textContent =
        `Day ${Math.floor((shown - START) / 24) + 1}/${days}  ` +
        `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}  ` +
        `Sheet ${cursor}→${mod(cursor + 1, N)}  ${A ? A.key.split('@')[1] : '–'}/${B ? B.key.split('@')[1] : '–'}px\n` +
        `${renderer.kind}  Canvas ${canvas.width}×${canvas.height}  Req ${hiSize}px\n` +
        `Paints ${fps.toFixed(0)}/s  ${avg.toFixed(2)} ms  Textures ${renderer.textures}\n` +
        `${LO}px ${loSrc.filter(Boolean).length}/${N} ${lo.size} decoded  Hi ${hi.size}  In flight ${inflight} ${(bytes / 1048576).toFixed(1)} MB`;
    }, 250);
  }
})();
