// 툭 반듯하게 자르기: 비스듬히 찍은 문서 사진의 네 모서리를 잡아 반듯한 직사각형으로 편다.
// 모두 이 브라우저 안에서 한다.
(() => {
  'use strict';

  const MAX_SIDE = 3000;

  /** 8개의 미지수를 푸는 가우스 소거 (4쌍의 점 → 원근 변환) */
  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      if (Math.abs(A[p][i]) < 1e-10) return null;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }

  /** 결과의 (u,v) → 원본의 (x,y)로 가는 원근 변환. dst: 결과 네 귀퉁이, src: 원본 네 점 */
  function homography(dst, src) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [u, v] = dst[i], [x, y] = src[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    return solve(A, b);
  }

  /**
   * 원본 캔버스에서 네 점(왼쪽 위 → 오른쪽 위 → 오른쪽 아래 → 왼쪽 아래, 픽셀)으로 둘러싼 곳을 반듯하게 편다.
   * 돌려주는 값: 캔버스
   */
  function warp(base, q) {
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    let H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const k = Math.min(1, MAX_SIDE / Math.max(W, H));
    W = Math.max(8, Math.round(W * k)); H = Math.max(8, Math.round(H * k));
    const h = homography([[0, 0], [W, 0], [W, H], [0, H]], q);
    if (!h) throw new Error('모서리를 다시 잡아 주세요');
    const sw = base.width, sh = base.height;
    const src = base.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    const g = out.getContext('2d');
    const img = g.createImageData(W, H), d = img.data;
    for (let v = 0; v < H; v++) {
      for (let u = 0; u < W; u++) {
        const uu = u + 0.5, vv = v + 0.5;
        const z = h[6] * uu + h[7] * vv + 1;
        let x = (h[0] * uu + h[1] * vv + h[2]) / z - 0.5, y = (h[3] * uu + h[4] * vv + h[5]) / z - 0.5;
        if (x < 0) x = 0; else if (x > sw - 1) x = sw - 1;
        if (y < 0) y = 0; else if (y > sh - 1) y = sh - 1;
        const x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < sw ? x0 + 1 : x0, y1 = y0 + 1 < sh ? y0 + 1 : y0;
        const tx = x - x0, ty = y - y0;
        const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, e = (y1 * sw + x1) * 4;
        const o = (v * W + u) * 4;
        for (let ch = 0; ch < 3; ch++) {
          d[o + ch] = (src[a + ch] * (1 - tx) + src[b + ch] * tx) * (1 - ty) + (src[c + ch] * (1 - tx) + src[e + ch] * tx) * ty;
        }
        d[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    return out;
  }

  /**
   * 문서의 네 귀퉁이를 어림잡는다. 바탕과 밝기가 다른 종이(어두운 책상 위의 흰 종이, 밝은 책상 위의 색종이)를 찾는다.
   * 돌려주는 값: [[x, y] × 4] (0~1, 왼쪽 위 → 오른쪽 위 → 오른쪽 아래 → 왼쪽 아래) 또는 null (자신 없을 때)
   */
  function detect(base) {
    // 작게 줄여서 본다
    const W = 200, H = Math.max(8, Math.round(200 * base.height / base.width));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(base, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const n = W * H;
    let lum = new Uint8Array(n);
    for (let i = 0; i < n; i++) lum[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
    // 글씨·잡티가 덩어리를 끊지 않게 3×3으로 뭉갠다 (두 번)
    for (let pass = 0; pass < 2; pass++) {
      const out = new Uint8Array(n);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let sum = 0, cnt = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= H || xx >= W) continue;
          sum += lum[yy * W + xx]; cnt++;
        }
        out[y * W + x] = sum / cnt;
      }
      lum = out;
    }
    // 밝은 쪽·어두운 쪽을 가르는 값 (오츠)
    const hist = new Float64Array(256);
    for (let i = 0; i < n; i++) hist[lum[i]]++;
    let total = 0; for (let i = 0; i < 256; i++) total += i * hist[i];
    let sumB = 0, wB = 0, best = -1, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (wB === 0) continue;
      const wF = n - wB; if (wF === 0) break;
      sumB += t * hist[t];
      const between = wB * wF * Math.pow(sumB / wB - (total - sumB) / wF, 2);
      if (between > best) { best = between; thr = t; }
    }
    // 종이는 사진 가운데에 있다고 본다: 가운데 네모에서 더 많은 쪽이 종이
    let bright = 0, cnt = 0;
    for (let y = Math.round(H * 0.35); y < H * 0.65; y++) for (let x = Math.round(W * 0.35); x < W * 0.65; x++) { if (lum[y * W + x] > thr) bright++; cnt++; }
    const paperBright = bright * 2 >= cnt;
    const isPaper = (i) => (lum[i] > thr) === paperBright;
    // 가운데에서 이어진 종이 덩어리
    const seen = new Uint8Array(n), stack = [];
    for (let y = Math.round(H * 0.4); y < H * 0.6; y++) for (let x = Math.round(W * 0.4); x < W * 0.6; x++) {
      const i = y * W + x;
      if (isPaper(i) && !seen[i]) { seen[i] = 1; stack.push(i); }
    }
    if (!stack.length) return null;
    let area = 0;
    let tl = null, tr = null, br = null, bl = null, minS = 1e9, maxS = -1e9, minD = 1e9, maxD = -1e9;
    while (stack.length) {
      const i = stack.pop(); area++;
      const x = i % W, y = (i - x) / W;
      // 화면 비율이 달라도 고르게 재려고 0~1로 맞춘 뒤 대각선 방향으로 가장 먼 점을 귀퉁이로
      const nx = x / (W - 1), ny = y / (H - 1), s = nx + ny, df = nx - ny;
      if (s < minS) { minS = s; tl = [nx, ny]; }
      if (s > maxS) { maxS = s; br = [nx, ny]; }
      if (df > maxD) { maxD = df; tr = [nx, ny]; }
      if (df < minD) { minD = df; bl = [nx, ny]; }
      if (x > 0 && !seen[i - 1] && isPaper(i - 1)) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < W - 1 && !seen[i + 1] && isPaper(i + 1)) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - W] && isPaper(i - W)) { seen[i - W] = 1; stack.push(i - W); }
      if (y < H - 1 && !seen[i + W] && isPaper(i + W)) { seen[i + W] = 1; stack.push(i + W); }
    }
    const frac = area / n;
    // 너무 작거나(종이가 아님) 사진을 거의 다 채우면(바탕과 구분이 안 됨) 자신 없음
    if (frac < 0.12 || frac > 0.93) return null;
    const q = [tl, tr, br, bl];
    // 네 점으로 만든 네모의 넓이가 덩어리 넓이와 비슷해야 네모난 종이다
    let quad = 0;
    for (let i = 0; i < 4; i++) { const a = q[i], b = q[(i + 1) % 4]; quad += a[0] * b[1] - b[0] * a[1]; }
    quad = Math.abs(quad) / 2;
    if (quad < frac * 0.8 || quad > frac * 1.25) return null;
    return q;
  }

  /**
   * 편집 화면을 연다.
   * @param {File[]} files 사진들 (한 장씩 차례로)
   * @param {HTMLElement} mount
   * @param {{decode: (f: File) => Promise<ImageBitmap|HTMLImageElement>, status: (t: string, bad?: boolean) => void,
   *          made: (blob: Blob, file: File, scan: boolean) => Promise<void>, finished: (count: number) => void, closed: () => void}} cb
   */
  async function open(files, mount, cb) {
    let index = 0, made = 0, closed = false;
    let base = null;                 // 지금 사진 (돌린 것까지 반영, 긴 쪽 3000픽셀까지)
    let pts = [];                    // 네 모서리, 0~1 (왼쪽 위 → 오른쪽 위 → 오른쪽 아래 → 왼쪽 아래)
    const NAMES = ['왼쪽 위', '오른쪽 위', '오른쪽 아래', '왼쪽 아래'];
    let found = null;               // 저절로 찾은 귀퉁이 (없으면 null)
    const START = () => (found ? found.map((p) => p.slice()) : [[0.06, 0.06], [0.94, 0.06], [0.94, 0.94], [0.06, 0.94]]);

    mount.hidden = false;
    mount.innerHTML =
      '<div class="pages-head"><b>반듯하게 자르기 <span class="crop-n"></span></b><span>동그라미 네 개를 문서의 네 귀퉁이로 옮기세요. 비스듬히 찍힌 사진이 반듯하게 펴져요.</span></div>' +
      '<div class="crop-stage"><canvas></canvas><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path class="dim" fill-rule="evenodd"></path><polygon></polygon></svg>' +
      NAMES.map((n, i) => '<button type="button" class="crop-pt" data-i="' + i + '" aria-label="' + n + ' 모서리 (화살표 키로 옮기기)"></button>').join('') + '</div>' +
      '<div class="bar crop-bar"><button type="button" class="btn primary" data-act="ok">이대로 자르기</button>' +
      '<button type="button" class="btn small" data-act="rot">돌리기</button>' +
      '<button type="button" class="btn small" data-act="reset">모서리 처음으로</button>' +
      '<label class="crop-check"><input type="checkbox" name="scan"> 스캔처럼 보정도 함께</label>' +
      '<button type="button" class="btn small" data-act="skip">이 사진 건너뛰기</button>' +
      '<button type="button" class="btn small" data-act="close">닫기</button></div>';
    const stage = mount.querySelector('.crop-stage'), view = stage.querySelector('canvas');
    const poly = stage.querySelector('polygon'), dim = stage.querySelector('.dim');
    const handles = [...stage.querySelectorAll('.crop-pt')];
    const nEl = mount.querySelector('.crop-n'), scanBox = mount.querySelector('input[name=scan]');
    const btn = (a) => mount.querySelector('[data-act="' + a + '"]');
    try { scanBox.checked = localStorage.getItem('tuk.cropScan') === '1'; } catch (_) { /* 무시 */ }

    function draw() {
      handles.forEach((hd, i) => { hd.style.left = pts[i][0] * 100 + '%'; hd.style.top = pts[i][1] * 100 + '%'; });
      const p = pts.map(([x, y]) => (x * 100).toFixed(2) + ',' + (y * 100).toFixed(2));
      poly.setAttribute('points', p.join(' '));
      dim.setAttribute('d', 'M0,0H100V100H0Z M' + p.join(' L') + 'Z');
    }
    const clamp = (v) => Math.min(1, Math.max(0, v));

    handles.forEach((hd, i) => {
      let dragging = false;
      hd.addEventListener('pointerdown', (e) => { dragging = true; hd.setPointerCapture(e.pointerId); e.preventDefault(); });
      hd.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const r = view.getBoundingClientRect();
        pts[i] = [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
        draw();
      });
      const end = () => { dragging = false; };
      hd.addEventListener('pointerup', end);
      hd.addEventListener('pointercancel', end);
      hd.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 0.05 : 0.01;
        const m = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (!m) return;
        e.preventDefault();
        pts[i] = [clamp(pts[i][0] + m[0]), clamp(pts[i][1] + m[1])];
        draw();
      });
    });

    function show(canvas) {
      base = canvas;
      view.width = base.width; view.height = base.height;
      view.getContext('2d').drawImage(base, 0, 0);
      // 화면 높이의 70%를 넘지 않게
      stage.style.maxWidth = Math.round(Math.min(1, (window.innerHeight * 0.7) / base.height * base.width / Math.max(1, mount.clientWidth)) * 100) + '%';
      try { found = detect(base); } catch (_) { found = null; }
      pts = START();
      draw();
    }

    async function load() {
      if (closed) return;
      if (index >= files.length) { close(); cb.finished(made); return; }
      nEl.textContent = files.length > 1 ? (index + 1) + '/' + files.length : '';
      setBusy(true);
      cb.status('사진을 여는 중… ' + files[index].name);
      try {
        const src = await cb.decode(files[index]);
        let w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
        const k = Math.min(1, MAX_SIDE / Math.max(w, h));
        w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.drawImage(src, 0, 0, w, h);
        if (src.close) src.close();
        show(c);
        cb.status(files[index].name + (found
          ? ' — 귀퉁이를 저절로 잡았어요. 맞으면 \'이대로 자르기\'를, 어긋났으면 동그라미를 옮겨 주세요.'
          : ' — 네 귀퉁이를 맞추고 \'이대로 자르기\'를 누르세요.'));
      } catch (e) {
        cb.status(files[index].name + ': ' + ((e && e.message) || '사진을 열지 못했어요'), true);
        index++;
        setBusy(false);
        return load();
      }
      setBusy(false);
    }

    function setBusy(v) { mount.querySelectorAll('button').forEach((b) => (b.disabled = v)); }

    function rotate() {
      if (!base) return;
      const c = document.createElement('canvas');
      c.width = base.height; c.height = base.width;
      const g = c.getContext('2d');
      g.translate(c.width / 2, c.height / 2);
      g.rotate(Math.PI / 2);
      g.drawImage(base, -base.width / 2, -base.height / 2);
      show(c);
    }

    async function cut() {
      if (!base) return;
      setBusy(true);
      const file = files[index];
      try {
        cb.status('반듯하게 펴는 중… ' + file.name);
        await new Promise((r) => setTimeout(r, 30));   // 글씨가 먼저 보이게
        const q = pts.map(([x, y]) => [x * base.width, y * base.height]);
        const out = warp(base, q);
        const blob = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('그림을 만들지 못했어요'))), 'image/jpeg', 0.9));
        out.width = out.height = 0;
        try { localStorage.setItem('tuk.cropScan', scanBox.checked ? '1' : '0'); } catch (_) { /* 무시 */ }
        await cb.made(blob, file, scanBox.checked);
        made++;
      } catch (e) {
        cb.status(file.name + ': ' + ((e && e.message) || '자르지 못했어요'), true);
        setBusy(false);
        return;
      }
      index++;
      setBusy(false);
      load();
    }

    function close() {
      if (closed) return;
      closed = true;
      mount.hidden = true; mount.innerHTML = '';
      base = null;
      cb.closed();
    }

    btn('ok').addEventListener('click', cut);
    btn('rot').addEventListener('click', rotate);
    btn('reset').addEventListener('click', () => { pts = START(); draw(); });
    btn('skip').addEventListener('click', () => { index++; load(); });
    btn('close').addEventListener('click', () => { close(); cb.finished(made); });

    await load();
    mount.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return {
      close,
      /** 점검용: 모서리를 0~1 값으로 직접 놓는다 */
      setCorners: (list) => { pts = list.map(([x, y]) => [clamp(x), clamp(y)]); draw(); },
    };
  }

  window.TukCrop = { open, warp, detect };
})();
