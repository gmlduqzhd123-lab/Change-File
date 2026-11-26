// 툭 PDF 손질: 합치기 · 쪽 빼기 · 돌리기 · 순서 바꾸기. 모두 이 브라우저 안에서 한다.
// pdf-lib(만들기·고치기)과 pdf.js(쪽 그림)는 PDF를 놓았을 때만 불러온다.
(() => {
  'use strict';

  const LIBS = {
    pdfLib: ['https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js', 'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI'],
    pdfJs: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', 'sha384-/1qUCSGwTur9vjf/z9lmu/eCUYbpOTgSjmpbMQZ1/CtX2v/WcAIKqRv+U1DUCG6e'],
    worker: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', 'sha384-SnzOobpRMLXZ52iJvZm/C0fYw0OQemTXzTjIsdsfMcrCtCEe9qgzxTd3RSklO5x2'],
  };
  const MAX_PAGES = 500;

  function loadScript([src, integrity]) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.integrity = integrity; s.crossOrigin = 'anonymous'; s.referrerPolicy = 'no-referrer';
      s.onload = resolve;
      s.onerror = () => reject(new Error('PDF 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요'));
      document.head.appendChild(s);
    });
  }

  let pdfLibReady = null, pdfJsReady = null;
  function needPdfLib() {
    if (!pdfLibReady) pdfLibReady = loadScript(LIBS.pdfLib).catch((e) => { pdfLibReady = null; throw e; });
    return pdfLibReady;
  }
  function needPdfJs() {
    if (!pdfJsReady) {
      pdfJsReady = (async () => {
        await loadScript(LIBS.pdfJs);
        // 다른 사이트의 워커는 바로 못 쓰니, 무결성을 확인하며 받아서 이 페이지의 워커로 만든다
        const r = await fetch(LIBS.worker[0], { integrity: LIBS.worker[1], mode: 'cors', referrerPolicy: 'no-referrer' });
        if (!r.ok) throw new Error('PDF 도구를 불러오지 못했어요');
        const url = URL.createObjectURL(new Blob([await r.text()], { type: 'text/javascript' }));
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = url;
      })().catch((e) => { pdfJsReady = null; throw e; });
    }
    return pdfJsReady;
  }

  const stem = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(0, i) : n; };
  const byName = (a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true, sensitivity: 'base' });

  async function openPdf(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try {
      return { bytes, doc: await window.PDFLib.PDFDocument.load(bytes, { updateMetadata: false }) };
    } catch (e) {
      if (/encrypt/i.test((e && e.message) || '')) throw new Error(file.name + ': 암호가 걸린 PDF라서 고칠 수 없어요');
      throw new Error(file.name + ': PDF가 손상됐거나 읽을 수 없어요');
    }
  }

  /** spec 순서대로 쪽을 모아 새 PDF를 만든다. spec: [{src, page, rot}] */
  async function build(sources, spec) {
    const { PDFDocument, degrees } = window.PDFLib;
    const out = await PDFDocument.create();
    const copied = new Map();
    for (let s = 0; s < sources.length; s++) {
      const want = spec.filter((p) => p.src === s).map((p) => p.page);
      if (want.length === 0) continue;
      const pages = await out.copyPages(sources[s].doc, want);
      want.forEach((n, i) => copied.set(s + ':' + n, pages[i]));
    }
    for (const p of spec) {
      const page = out.addPage(copied.get(p.src + ':' + p.page));
      if (p.rot) page.setRotation(degrees((((page.getRotation().angle + p.rot) % 360) + 360) % 360));
    }
    return new Blob([await out.save()], { type: 'application/pdf' });
  }

  /** PDF 여러 개를 이름 순서(1, 2, 10…)대로 하나로 */
  async function merge(files, status) {
    await needPdfLib();
    const list = [...files].sort(byName);
    const sources = [];
    for (let i = 0; i < list.length; i++) {
      status('PDF 여는 중… ' + (i + 1) + '/' + list.length);
      sources.push(await openPdf(list[i]));
    }
    const spec = [];
    sources.forEach((s, src) => { for (let page = 0; page < s.doc.getPageCount(); page++) spec.push({ src, page, rot: 0 }); });
    status('하나로 합치는 중… ' + spec.length + '쪽');
    return { blob: await build(sources, spec), name: stem(list[0].name) + '_합침.pdf', pages: spec.length };
  }

  const pad = (n, total) => String(n).padStart(String(total).length < 2 ? 2 : String(total).length, '0');

  /** PDF마다 쪽을 하나씩 따로 PDF로. 돌려주는 값: [{name, blob}] */
  async function split(files, status) {
    await needPdfLib();
    const list = [...files].sort(byName);
    const out = [];
    for (const f of list) {
      const s = await openPdf(f);
      const n = s.doc.getPageCount();
      for (let page = 0; page < n; page++) {
        status(f.name + ' 나누는 중… ' + (page + 1) + '/' + n);
        out.push({ name: stem(f.name) + '_' + pad(page + 1, n) + '쪽.pdf', blob: await build([s], [{ src: 0, page, rot: 0 }]) });
      }
    }
    return out;
  }

  /** PDF 쪽을 JPG 그림으로 (150dpi, 긴 쪽 최대 3000픽셀). 돌려주는 값: [{name, blob}] */
  async function toJpg(files, status) {
    await needPdfJs();
    const list = [...files].sort(byName);
    const out = [];
    for (const f of list) {
      let view;
      try { view = await window.pdfjsLib.getDocument({ data: new Uint8Array(await f.arrayBuffer()), isEvalSupported: false }).promise; }
      catch (e) {
        if (e && e.name === 'PasswordException') throw new Error(f.name + ': 암호가 걸린 PDF라서 열 수 없어요');
        throw new Error(f.name + ': PDF가 손상됐거나 읽을 수 없어요');
      }
      try {
        const n = view.numPages;
        if (n > MAX_PAGES) throw new Error(f.name + ': 쪽이 너무 많아요 (' + MAX_PAGES + '쪽까지)');
        for (let i = 1; i <= n; i++) {
          status(f.name + ' 그림으로 바꾸는 중… ' + i + '/' + n);
          const page = await view.getPage(i);
          const vp1 = page.getViewport({ scale: 1 });
          const scale = Math.min(150 / 72, 3000 / Math.max(vp1.width, vp1.height));
          const vp = page.getViewport({ scale });
          const c = document.createElement('canvas');
          c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
          const g = c.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
          await page.render({ canvasContext: g, viewport: vp }).promise;
          const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.9));
          c.width = c.height = 0;
          page.cleanup();
          out.push({ name: stem(f.name) + (n > 1 ? '_' + pad(i, n) + '쪽' : '') + '.jpg', blob });
        }
      } finally { view.destroy(); }
    }
    return out;
  }

  /**
   * 스캔한 PDF 용량 줄이기: 글자가 없는(그림뿐인) 쪽만 낮은 해상도 JPG로 다시 그린다.
   * 글자가 있는 쪽은 그대로 옮겨서 글자 고르기·검색이 그대로 된다.
   * @param {{dpi: number, quality: number}} o
   * 돌려주는 값: [{name, blob, note}] 또는 [{message}] (줄일 것이 없을 때)
   */
  async function squeeze(files, o, status) {
    await Promise.all([needPdfLib(), needPdfJs()]);
    const { PDFDocument } = window.PDFLib;
    const out = [];
    for (const f of [...files].sort(byName)) {
      const src = await openPdf(f);
      let view;
      try { view = await window.pdfjsLib.getDocument({ data: src.bytes.slice(), isEvalSupported: false }).promise; }
      catch (e) { throw new Error(f.name + ': PDF가 손상됐거나 읽을 수 없어요'); }
      try {
        const n = view.numPages;
        if (n > MAX_PAGES) throw new Error(f.name + ': 쪽이 너무 많아요 (' + MAX_PAGES + '쪽까지)');
        const doc = await PDFDocument.create();
        let scanned = 0;
        for (let i = 1; i <= n; i++) {
          status(f.name + ' 줄이는 중… ' + i + '/' + n);
          const page = await view.getPage(i);
          const text = await page.getTextContent();
          const hasText = text.items.some((t) => t.str && t.str.trim());
          if (hasText) {
            const [copy] = await doc.copyPages(src.doc, [i - 1]);
            doc.addPage(copy);
          } else {
            // 보이는 방향 그대로 그린 그림을 같은 크기 쪽에 깐다 (돌림 정보는 그림에 반영됨)
            const vp1 = page.getViewport({ scale: 1 });
            const scale = Math.min(o.dpi / 72, 4000 / Math.max(vp1.width, vp1.height));
            const vp = page.getViewport({ scale });
            const c = document.createElement('canvas');
            c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
            const g = c.getContext('2d');
            g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
            await page.render({ canvasContext: g, viewport: vp }).promise;
            const jpg = await new Promise((res) => c.toBlob(res, 'image/jpeg', o.quality));
            c.width = c.height = 0;
            const img = await doc.embedJpg(new Uint8Array(await jpg.arrayBuffer()));
            const p = doc.addPage([vp1.width, vp1.height]);
            p.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
            scanned++;
          }
          page.cleanup();
        }
        if (scanned === 0) { out.push({ message: f.name + '은(는) 글자로 된 PDF라 줄일 그림 쪽이 없어요' }); continue; }
        const bytes = await doc.save();
        if (bytes.length >= f.size * 0.95) { out.push({ message: f.name + '은(는) 이미 충분히 작아요' }); continue; }
        const note = size(f.size) + ' → ' + size(bytes.length) + (scanned < n ? ' · 그림 쪽 ' + scanned + '/' + n : '');
        out.push({ name: stem(f.name) + '_줄임.pdf', blob: new Blob([bytes], { type: 'application/pdf' }), note });
      } finally { view.destroy(); }
    }
    return out;
  }

  const size = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB');

  // ── 쪽 위에 그리기 (쪽 번호·워터마크) ──
  // 돌려 둔 쪽(/Rotate)도 '보이는 방향' 기준으로 그린다.
  // 보이는 좌표(vx, vy: 왼쪽 아래가 0)를 PDF 좌표로 바꾼다.
  function frame(page) {
    const box = page.getCropBox();
    const r = ((page.getRotation().angle % 360) + 360) % 360;
    const W = box.width, H = box.height;
    const vw = r % 180 ? H : W, vh = r % 180 ? W : H;
    const map = (vx, vy) => {
      let x, y;
      if (r === 90) { x = W - vy; y = vx; }
      else if (r === 180) { x = W - vx; y = H - vy; }
      else if (r === 270) { x = vy; y = H - vx; }
      else { x = vx; y = vy; }
      return { x: x + box.x, y: y + box.y };
    };
    return { r, vw, vh, map };
  }

  async function eachPdf(files, suffix, status, paint) {
    await needPdfLib();
    const out = [];
    for (const f of [...files].sort(byName)) {
      status(f.name + ' 고치는 중…');
      const { doc } = await openPdf(f);
      await paint(doc, f);
      out.push({ name: stem(f.name) + suffix + '.pdf', blob: new Blob([await doc.save()], { type: 'application/pdf' }) });
    }
    return out;
  }

  /**
   * 쪽 번호 넣기
   * @param {{where: 'bc'|'br'|'tr', style: 'n'|'nt'|'dash', start: number, skipFirst: boolean}} o
   */
  function pageNumbers(files, o, status) {
    return eachPdf(files, '_쪽번호', status, async (doc) => {
      const { StandardFonts, degrees, rgb } = window.PDFLib;
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pages = doc.getPages();
      const counted = o.skipFirst ? pages.length - 1 : pages.length;
      pages.forEach((page, i) => {
        if (o.skipFirst && i === 0) return;
        const n = (o.skipFirst ? i : i + 1) + (o.start - 1);
        const last = counted + (o.start - 1);
        const text = o.style === 'nt' ? n + ' / ' + last : o.style === 'dash' ? '- ' + n + ' -' : String(n);
        const f = frame(page);
        const size = Math.max(8, Math.min(14, Math.min(f.vw, f.vh) / 56));
        const tw = font.widthOfTextAtSize(text, size);
        const m = Math.min(f.vw, f.vh) * 0.045;
        const vx = o.where === 'bc' ? (f.vw - tw) / 2 : f.vw - m - tw;
        const vy = o.where === 'tr' ? f.vh - m - size * 0.75 : m;
        const at = f.map(vx, vy);
        page.drawText(text, { x: at.x, y: at.y, size, font, color: rgb(0.2, 0.2, 0.2), rotate: degrees(f.r) });
      });
    });
  }

  /** 글씨를 그림으로 만든다 (한글 글꼴을 PDF에 넣지 않아도 되게) */
  async function textImage(doc, text, alpha) {
    const px = 160;
    const c = document.createElement('canvas');
    const g = c.getContext('2d');
    const font = 'bold ' + px + 'px "Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + px / 2;
    c.width = w; c.height = Math.ceil(px * 1.4);
    g.font = font;
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillStyle = 'rgba(120, 120, 120, ' + alpha + ')';
    g.fillText(text, w / 2, c.height / 2);
    const png = await new Promise((res) => c.toBlob(res, 'image/png'));
    return { img: await doc.embedPng(new Uint8Array(await png.arrayBuffer())), ratio: c.height / c.width };
  }

  /**
   * 글씨 워터마크
   * @param {{text: string, alpha: number, diagonal: boolean}} o
   */
  function watermark(files, o, status) {
    return eachPdf(files, '_워터마크', status, async (doc) => {
      const { degrees } = window.PDFLib;
      const { img, ratio } = await textImage(doc, o.text, o.alpha);
      for (const page of doc.getPages()) {
        const f = frame(page);
        const t = o.diagonal ? Math.atan2(f.vh, f.vw) : 0;
        const span = o.diagonal ? Math.hypot(f.vw, f.vh) * 0.7 : f.vw * 0.8;
        let w = span, h = span * ratio;
        if (h > f.vh * 0.3 && !o.diagonal) { h = f.vh * 0.3; w = h / ratio; }
        // 가운데에 오도록, 돌린 그림의 왼쪽 아래 꼭짓점을 구한다
        const cx = f.vw / 2, cy = f.vh / 2;
        const vx = cx - (Math.cos(t) * w - Math.sin(t) * h) / 2;
        const vy = cy - (Math.sin(t) * w + Math.cos(t) * h) / 2;
        const at = f.map(vx, vy);
        page.drawImage(img, { x: at.x, y: at.y, width: w, height: h, rotate: degrees(f.r + t * 180 / Math.PI) });
      }
    });
  }

  // ── 쪽 고르기 화면 ──
  /**
   * @param {File[]} files
   * @param {HTMLElement} mount
   * @param {{status: (t: string, bad?: boolean) => void, done: (blob: Blob, name: string, note: string) => void, closed: () => void,
   *   images?: (list: {file: File, rot: number}[]) => Promise<Blob>}} cb  images가 있으면 사진 순서 정하기 (사진 한 장 = 한 쪽)
   */
  async function edit(files, mount, cb) {
    const photos = typeof cb.images === 'function';
    const unit = photos ? '장' : '쪽';
    const list = [...files].sort(byName);
    const sources = [];
    let pages = [];
    if (photos) {
      if (list.length > MAX_PAGES) throw new Error('사진이 너무 많아요 (' + MAX_PAGES + '장까지)');
      list.forEach((f, i) => { sources.push({ name: f.name, file: f }); pages.push({ src: i, page: 0, rot: 0, del: false }); });
    } else {
      cb.status('PDF 도구를 불러오는 중…');
      await Promise.all([needPdfLib(), needPdfJs()]);
      for (let i = 0; i < list.length; i++) {
        cb.status('PDF 여는 중… ' + (i + 1) + '/' + list.length);
        const s = await openPdf(list[i]);
        s.name = list[i].name;
        s.view = await window.pdfjsLib.getDocument({ data: s.bytes.slice(), isEvalSupported: false }).promise;
        sources.push(s);
        for (let page = 0; page < s.doc.getPageCount(); page++) pages.push({ src: i, page, rot: 0, del: false });
        if (pages.length > MAX_PAGES) throw new Error('쪽이 너무 많아요 (' + MAX_PAGES + '쪽까지). PDF를 나눠서 해 주세요');
      }
    }
    pages.forEach((p, i) => { p.id = i; });
    const original = pages.slice();
    cb.status('');

    mount.hidden = false;
    mount.innerHTML =
      (photos
        ? '<div class="pages-head"><b>사진 순서 정하기</b><span>사진을 끌어(휴대폰은 꾹 눌러서) 옮기거나 <b>앞으로</b>·<b>뒤로</b>로 순서를 바꾸고, <b>돌리기</b>·<b>빼기</b>도 할 수 있어요. 사진 한 장이 A4 한 쪽이 돼요.</span></div>'
        : '<div class="pages-head"><b>쪽 고르기</b><span>쪽마다 <b>빼기</b>·<b>돌리기</b>를 누르고, 쪽을 끌어(휴대폰은 꾹 눌러서) 옮기거나 <b>앞으로</b>·<b>뒤로</b>로 순서를 바꿔요.</span></div>') +
      '<ol class="thumbs"></ol>' +
      '<div class="bar"><button type="button" class="btn primary" data-act="make"></button>' +
      '<button type="button" class="btn small" data-act="reset">처음대로</button>' +
      '<button type="button" class="btn small" data-act="close">닫기</button></div>';
    const grid = mount.querySelector('.thumbs');
    const makeBtn = mount.querySelector('[data-act="make"]');

    // 쪽 그림은 화면에 보일 때만 그린다
    const seen = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        seen.unobserve(en.target);
        draw(en.target);
      }
    }, { rootMargin: '200px' });
    const cards = new Map();
    let dragId = null;
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

    async function draw(card) {
      const p = pages.find((x) => x.id === Number(card.dataset.id));
      try {
        if (photos) {
          // 사진은 회전 정보(EXIF)를 반영해 작게 그린다
          const bmp = await createImageBitmap(sources[p.src].file, { imageOrientation: 'from-image' });
          const s = Math.min(150 / bmp.width, 200 / bmp.height, 1) * (window.devicePixelRatio || 1);
          const c = card.querySelector('canvas');
          c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
          c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
          bmp.close();
          card.classList.add('drawn');
          return;
        }
        const page = await sources[p.src].view.getPage(p.page + 1);
        const vp0 = page.getViewport({ scale: 1 });
        const scale = Math.min(150 / vp0.width, 200 / vp0.height) * (window.devicePixelRatio || 1);
        const vp = page.getViewport({ scale });
        const c = card.querySelector('canvas');
        c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
        await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        card.classList.add('drawn');
      } catch (_) { card.querySelector('.paper').classList.add('broken'); }
    }

    function card(p) {
      let li = cards.get(p.id);
      if (li) return li;
      li = document.createElement('li');
      li.className = 'thumb';
      li.dataset.id = String(p.id);
      // 마우스는 끌어다 놓기, 손가락은 아래의 '꾹 눌러 끌기'
      li.draggable = !coarse;
      li.innerHTML =
        '<div class="paper"><canvas></canvas></div>' +
        '<div class="cap"><span class="no"></span><span class="from"></span></div>' +
        '<div class="tools">' +
        '<button type="button" data-a="rot" title="오른쪽으로 90도">⟳ 돌리기</button>' +
        '<button type="button" data-a="del"></button>' +
        '<button type="button" data-a="left">◀ 앞으로</button>' +
        '<button type="button" data-a="right">뒤로 ▶</button></div>';
      li.querySelector('.from').textContent = photos ? sources[p.src].name : sources.length > 1 ? sources[p.src].name + ' ' + (p.page + 1) + '쪽' : '';
      li.addEventListener('click', (e) => {
        const a = e.target.closest('button') && e.target.closest('button').dataset.a;
        if (!a) return;
        const i = pages.findIndex((x) => x.id === p.id);
        if (a === 'rot') p.rot = (p.rot + 90) % 360;
        if (a === 'del') p.del = !p.del;
        if (a === 'left' && i > 0) [pages[i - 1], pages[i]] = [pages[i], pages[i - 1]];
        if (a === 'right' && i < pages.length - 1) [pages[i + 1], pages[i]] = [pages[i], pages[i + 1]];
        layout();
        if (a === 'left' || a === 'right') li.querySelector('[data-a="' + a + '"]').focus();
      });
      li.addEventListener('dragstart', (e) => { dragId = p.id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(p.id)); });
      li.addEventListener('dragend', () => { dragId = null; li.classList.remove('dragging'); grid.querySelectorAll('.over').forEach((x) => x.classList.remove('over')); });
      li.addEventListener('dragover', (e) => { if (dragId === null || dragId === p.id) return; e.preventDefault(); e.stopPropagation(); li.classList.add('over'); });
      li.addEventListener('dragleave', () => li.classList.remove('over'));
      li.addEventListener('drop', (e) => {
        if (dragId === null) return;
        e.preventDefault(); e.stopPropagation();
        move(dragId, p.id);
      });
      touchDrag(li, p);
      cards.set(p.id, li);
      seen.observe(li);
      return li;
    }

    function move(fromId, toId) {
      if (fromId === toId) return;
      const from = pages.findIndex((x) => x.id === fromId);
      const moved = pages.splice(from, 1)[0];
      const to = pages.findIndex((x) => x.id === toId);
      pages.splice(from <= to ? to + 1 : to, 0, moved);
      layout();
    }

    // 손가락: 0.3초쯤 꾹 누르면 집어 들고, 놓을 자리 위에서 떼면 옮긴다. 그 전에 움직이면 화면 넘기기.
    function touchDrag(li, p) {
      let timer = null, holding = false, sx = 0, sy = 0, target = null;
      const clearOver = () => grid.querySelectorAll('.over').forEach((x) => x.classList.remove('over'));
      const stop = () => {
        clearTimeout(timer); timer = null;
        if (holding) { holding = false; li.classList.remove('dragging', 'lifted'); clearOver(); }
      };
      li.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' || e.target.closest('button')) return;
        sx = e.clientX; sy = e.clientY; target = null;
        timer = setTimeout(() => {
          holding = true;
          li.classList.add('dragging', 'lifted');
          if (navigator.vibrate) navigator.vibrate(15);
        }, 300);
      });
      li.addEventListener('pointermove', (e) => {
        if (e.pointerType === 'mouse') return;
        if (!holding) {
          if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) { clearTimeout(timer); timer = null; }
          return;
        }
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const over = under && under.closest('.thumb');
        clearOver();
        target = over && over !== li && grid.contains(over) ? over : null;
        if (target) target.classList.add('over');
      });
      li.addEventListener('pointerup', () => {
        if (holding && target) move(p.id, Number(target.dataset.id));
        stop();
      });
      li.addEventListener('pointercancel', stop);
      // 집어 든 동안에는 화면이 같이 움직이지 않게
      li.addEventListener('touchmove', (e) => { if (holding) e.preventDefault(); }, { passive: false });
      li.addEventListener('contextmenu', (e) => { if (timer || holding) e.preventDefault(); });
    }

    function layout() {
      let n = 0;
      pages.forEach((p, i) => {
        const li = card(p);
        if (grid.children[i] !== li) grid.insertBefore(li, grid.children[i] || null);
        li.classList.toggle('gone', p.del);
        li.querySelector('.paper canvas').style.transform = p.rot ? 'rotate(' + p.rot + 'deg)' : '';
        li.querySelector('.paper').classList.toggle('turned', p.rot % 180 !== 0);
        li.querySelector('.no').textContent = p.del ? '뺌' : (++n) + unit;
        li.querySelector('[data-a="del"]').textContent = p.del ? '되살리기' : '✕ 빼기';
      });
      makeBtn.textContent = n > 0 ? '이대로 PDF 만들기 (' + n + unit + ')' : (photos ? '남은 사진이 없어요' : '남은 쪽이 없어요');
      makeBtn.disabled = n === 0;
    }

    function close() {
      seen.disconnect();
      sources.forEach((s) => { try { if (s.view) s.view.destroy(); } catch (_) { /* 무시 */ } });
      mount.hidden = true;
      mount.innerHTML = '';
      cb.closed();
    }

    mount.querySelector('[data-act="reset"]').addEventListener('click', () => {
      pages = original.slice();
      pages.forEach((p) => { p.rot = 0; p.del = false; });
      layout();
    });
    mount.querySelector('[data-act="close"]').addEventListener('click', close);
    makeBtn.addEventListener('click', async () => {
      makeBtn.disabled = true;
      cb.status('PDF 만드는 중…');
      try {
        const keep = pages.filter((p) => !p.del);
        const blob = photos
          ? await cb.images(keep.map((p) => ({ file: sources[p.src].file, rot: p.rot })))
          : await build(sources, keep);
        const gone = pages.length - keep.length, turned = keep.filter((p) => p.rot).length;
        const name = stem(photos ? sources[keep[0].src].name : list[0].name) + (photos ? '_묶음.pdf' : sources.length > 1 ? '_합침.pdf' : '_고침.pdf');
        const what = [keep.length + unit];
        if (gone) what.push(gone + unit + ' 뺌');
        if (turned) what.push(turned + unit + ' 돌림');
        cb.done(blob, name, what.join(' · '));
      } catch (e) {
        cb.status('PDF를 만들지 못했어요: ' + ((e && e.message) || e), true);
      } finally { makeBtn.disabled = false; }
    });

    layout();
    mount.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return { close };
  }

  window.TukPdf = { merge, edit, split, toJpg, pageNumbers, watermark, squeeze };
})();
