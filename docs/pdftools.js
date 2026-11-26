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

  // ── 쪽 고르기 화면 ──
  /**
   * @param {File[]} files
   * @param {HTMLElement} mount
   * @param {{status: (t: string, bad?: boolean) => void, done: (blob: Blob, name: string, note: string) => void, closed: () => void}} cb
   */
  async function edit(files, mount, cb) {
    cb.status('PDF 도구를 불러오는 중…');
    await Promise.all([needPdfLib(), needPdfJs()]);
    const list = [...files].sort(byName);
    const sources = [];
    let pages = [];
    for (let i = 0; i < list.length; i++) {
      cb.status('PDF 여는 중… ' + (i + 1) + '/' + list.length);
      const s = await openPdf(list[i]);
      s.name = list[i].name;
      s.view = await window.pdfjsLib.getDocument({ data: s.bytes.slice(), isEvalSupported: false }).promise;
      sources.push(s);
      for (let page = 0; page < s.doc.getPageCount(); page++) pages.push({ src: i, page, rot: 0, del: false });
      if (pages.length > MAX_PAGES) throw new Error('쪽이 너무 많아요 (' + MAX_PAGES + '쪽까지). PDF를 나눠서 해 주세요');
    }
    pages.forEach((p, i) => { p.id = i; });
    const original = pages.slice();
    cb.status('');

    mount.hidden = false;
    mount.innerHTML =
      '<div class="pages-head"><b>쪽 고르기</b><span>쪽마다 <b>빼기</b>·<b>돌리기</b>를 누르고, 쪽을 끌어 옮기거나 <b>앞으로</b>·<b>뒤로</b>로 순서를 바꿔요.</span></div>' +
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

    async function draw(card) {
      const p = pages.find((x) => x.id === Number(card.dataset.id));
      try {
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
      li.draggable = true;
      li.innerHTML =
        '<div class="paper"><canvas></canvas></div>' +
        '<div class="cap"><span class="no"></span><span class="from"></span></div>' +
        '<div class="tools">' +
        '<button type="button" data-a="rot" title="오른쪽으로 90도">⟳ 돌리기</button>' +
        '<button type="button" data-a="del"></button>' +
        '<button type="button" data-a="left">◀ 앞으로</button>' +
        '<button type="button" data-a="right">뒤로 ▶</button></div>';
      li.querySelector('.from').textContent = sources.length > 1 ? sources[p.src].name + ' ' + (p.page + 1) + '쪽' : '';
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
        const from = pages.findIndex((x) => x.id === dragId);
        const moved = pages.splice(from, 1)[0];
        const to = pages.findIndex((x) => x.id === p.id);
        pages.splice(from <= to ? to + 1 : to, 0, moved);
        layout();
      });
      cards.set(p.id, li);
      seen.observe(li);
      return li;
    }

    function layout() {
      let n = 0;
      pages.forEach((p, i) => {
        const li = card(p);
        if (grid.children[i] !== li) grid.insertBefore(li, grid.children[i] || null);
        li.classList.toggle('gone', p.del);
        li.querySelector('.paper canvas').style.transform = p.rot ? 'rotate(' + p.rot + 'deg)' : '';
        li.querySelector('.paper').classList.toggle('turned', p.rot % 180 !== 0);
        li.querySelector('.no').textContent = p.del ? '뺌' : (++n) + '쪽';
        li.querySelector('[data-a="del"]').textContent = p.del ? '되살리기' : '✕ 빼기';
      });
      makeBtn.textContent = n > 0 ? '이대로 PDF 만들기 (' + n + '쪽)' : '남은 쪽이 없어요';
      makeBtn.disabled = n === 0;
    }

    function close() {
      seen.disconnect();
      sources.forEach((s) => { try { s.view.destroy(); } catch (_) { /* 무시 */ } });
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
        const blob = await build(sources, keep);
        const gone = pages.length - keep.length, turned = keep.filter((p) => p.rot).length;
        const name = stem(list[0].name) + (sources.length > 1 ? '_합침.pdf' : '_고침.pdf');
        const what = [keep.length + '쪽'];
        if (gone) what.push(gone + '쪽 뺌');
        if (turned) what.push(turned + '쪽 돌림');
        cb.done(blob, name, what.join(' · '));
      } catch (e) {
        cb.status('PDF를 만들지 못했어요: ' + ((e && e.message) || e), true);
      } finally { makeBtn.disabled = false; }
    });

    layout();
    mount.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return { close };
  }

  window.TukPdf = { merge, edit };
})();
