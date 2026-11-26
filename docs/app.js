// 툭 웹 버전: 모든 처리는 이 브라우저 안에서 한다. 파일을 어디로도 보내지 않는다.
(() => {
  'use strict';

  const IMG = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif'];
  const HEIC = ['heic', 'heif'];
  const OFFICE = ['hwp', 'hwpx', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt'];
  const $ = (s) => document.querySelector(s);
  const drop = $('#drop'), picker = $('#picker'), filesEl = $('#files'), actionsEl = $('#actions');
  const hintEl = $('#hint'), statusEl = $('#status'), resultsEl = $('#results'), resultBar = $('#resultBar');

  /** @type {{file: File, path: string}[]} */
  let items = [];
  /** @type {{name: string, blob: Blob, note?: string, url?: string}[]} */
  let results = [];
  let busy = false;

  // 그림 줄이기 크기 (긴 쪽 픽셀). 고른 값은 이 브라우저에만 기억한다.
  const SIZES = [[1024, '작게 · 1024픽셀'], [1600, '보통 · 1600픽셀'], [2560, '크게 · 2560픽셀']];
  let shrinkSide = 1600;
  try { const v = Number(localStorage.getItem('tuk.shrinkSide')); if (SIZES.some(([s]) => s === v)) shrinkSide = v; } catch (_) { /* 저장 못 해도 괜찮다 */ }

  const ext = (n) => (n.split('.').pop() || '').toLowerCase();
  const stem = (n) => { const b = n.split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; };
  const isImg = (it) => IMG.includes(ext(it.file.name));
  const isZip = (it) => ext(it.file.name) === 'zip';
  const isPdf = (it) => ext(it.file.name) === 'pdf';
  const isHeic = (it) => HEIC.includes(ext(it.file.name));
  const pagesEl = $('#pages');
  const isOffice = (it) => OFFICE.includes(ext(it.file.name));
  const size = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB';
  const topName = (it) => it.path.split('/')[0];

  // ── 파일 받기 ──
  drop.addEventListener('click', () => picker.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); picker.click(); } });
  picker.addEventListener('change', () => {
    setItems([...picker.files].map((f) => ({ file: f, path: f.name })));
    picker.value = '';
  });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'dragend'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const dt = e.dataTransfer;
    const entries = dt.items ? [...dt.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean) : [];
    if (entries.length) {
      const out = [];
      for (const en of entries) await walk(en, '', out);
      setItems(out);
    } else {
      setItems([...dt.files].map((f) => ({ file: f, path: f.name })));
    }
  });
  // 창 아무 데나 놓아도 브라우저가 파일을 열지 않게
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  async function walk(entry, prefix, out) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, prefix + entry.name + '/', out);
      } while (batch.length > 0);
    }
  }

  let editor = null;
  function closeEditor() { if (editor) { const e = editor; editor = null; e.close(); } }

  function setItems(list) {
    if (busy) return;
    closeEditor();
    items = list;
    clearResults();
    render();
  }

  // ── 화면 ──
  function render() {
    filesEl.innerHTML = '';
    const shown = items.slice(0, 8);
    for (const it of shown) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="kind"></span><span class="nm"></span><span class="sz"></span>';
      li.querySelector('.kind').textContent = (ext(it.file.name) || '파일').toUpperCase();
      li.querySelector('.nm').textContent = it.path;
      li.querySelector('.sz').textContent = size(it.file.size);
      filesEl.appendChild(li);
    }
    if (items.length > shown.length) {
      const li = document.createElement('li');
      li.textContent = '그 밖에 ' + (items.length - shown.length) + '개';
      filesEl.appendChild(li);
    }

    actionsEl.innerHTML = '';
    const imgs = items.filter(isImg).length;
    const pdfs = items.filter(isPdf).length;
    const choices = [];
    if (pdfs > 1) choices.push(['merge', 'PDF 합치기 (' + pdfs + '개)']);
    if (pdfs > 0) choices.push(['pages', pdfs > 1 ? '쪽 고르기·돌리기 (합쳐서)' : '쪽 빼기·돌리기·순서']);
    if (pdfs > 0) choices.push(['split', '쪽마다 나누기']);
    if (pdfs > 0) choices.push(['pdfjpg', 'PDF → JPG 그림']);
    if (imgs > 0) choices.push(['pdf', imgs > 1 ? '그림마다 PDF로' : 'PDF로']);
    if (imgs > 1) choices.push(['pdfall', 'PDF 하나로 묶기 (' + imgs + '장)']);
    const heics = items.filter(isHeic).length;
    if (heics > 0) choices.push(['tojpg', 'JPG로 바꾸기 (아이폰 사진 ' + heics + '장)']);
    if (imgs > 0) choices.push(['shrink', '그림 용량 줄이기']);
    if (items.length > 0) choices.push(['zip', 'ZIP으로 묶기']);
    if (items.length > 0 && items.every(isZip)) choices.push(['unzip', '압축 풀기']);
    choices.forEach(([id, label], i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (i === 0 ? ' primary' : '');
      b.textContent = label;
      b.addEventListener('click', () => run(id));
      if (id === 'shrink') {
        // 단추와 크기 고르기를 한 덩어리로
        const g = document.createElement('span');
        g.className = 'pair';
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', '줄일 크기');
        for (const [s, label] of SIZES) {
          const o = document.createElement('option');
          o.value = String(s); o.textContent = label; o.selected = s === shrinkSide;
          sel.appendChild(o);
        }
        sel.addEventListener('change', () => {
          shrinkSide = Number(sel.value);
          try { localStorage.setItem('tuk.shrinkSide', sel.value); } catch (_) { /* 무시 */ }
        });
        g.append(b, sel);
        actionsEl.appendChild(g);
      } else actionsEl.appendChild(b);
    });

    const office = items.filter(isOffice).length;
    const notice = [];
    if (office > 0) notice.push('<b>한글·워드·엑셀·PPT 문서 ' + office + '개</b>는 웹에서 PDF로 바꿀 수 없어요.');
    // 사파리 말고는 대부분 HEIC를 못 읽는다
    if (heics > 0 && !/^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent))
      notice.push('<b>아이폰 사진(HEIC)</b>은 크롬·엣지에서 못 읽을 수 있어요.');
    if (notice.length > 0) {
      hintEl.hidden = false;
      hintEl.className = 'hint office';
      hintEl.innerHTML = '<span>' + notice.join(' ') + ' 윈도우 프로그램은 탐색기에서 바로 바꿔요.</span>' +
        '<a class="btn small primary" href="download/Tuk.zip" download>윈도우 프로그램 받기</a>';
    } else hintEl.hidden = true;
  }

  function setStatus(text, bad) {
    statusEl.textContent = text;
    statusEl.classList.toggle('bad', !!bad);
  }

  function clearResults() {
    for (const r of results) if (r.url) URL.revokeObjectURL(r.url);
    results = [];
    resultsEl.innerHTML = '';
    resultBar.hidden = true;
    setStatus('');
  }

  function addResult(name, blob, note) {
    const r = { name, blob, note, url: URL.createObjectURL(blob) };
    results.push(r);
    const li = document.createElement('li');
    li.innerHTML = '<span class="nm"></span><span class="note"></span><a>받기</a>';
    li.querySelector('.nm').textContent = name;
    li.querySelector('.note').textContent = note || size(blob.size);
    const a = li.querySelector('a');
    a.href = r.url;
    a.download = name.split('/').pop();
    resultsEl.appendChild(li);
  }

  $('#clear').addEventListener('click', () => { closeEditor(); items = []; clearResults(); render(); });

  // ── PDF 쪽 고르기 ──
  async function openEditor() {
    if (busy || editor) return;
    busy = true;
    clearResults();
    actionsEl.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      editor = await window.TukPdf.edit(items.filter(isPdf).map((x) => x.file), pagesEl, {
        status: setStatus,
        done: (blob, name, note) => {
          for (const r of results) if (r.url) URL.revokeObjectURL(r.url);
          results = []; resultsEl.innerHTML = '';
          addResult(name, blob, note + ' · ' + size(blob.size));
          setStatus('다 됐어요. 받기를 누르세요. 더 고쳐서 다시 만들 수도 있어요.');
          resultBar.hidden = false;
          $('#zipAll').hidden = true;
        },
        closed: () => { editor = null; actionsEl.hidden = false; },
      });
      actionsEl.hidden = true;
    } catch (e) {
      editor = null;
      pagesEl.hidden = true; pagesEl.innerHTML = '';
      setStatus(why(e), true);
    } finally {
      busy = false;
      actionsEl.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
  }
  $('#zipAll').addEventListener('click', async () => {
    const zip = new JSZip();
    const used = new Set();
    for (const r of results) zip.file(uniqueName(r.name, used), r.blob);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    save(blob, '툭 결과.zip');
  });

  function uniqueName(name, used) {
    let n = name, i = 2;
    const dot = name.lastIndexOf('.');
    while (used.has(n)) { n = dot > 0 ? name.slice(0, dot) + ' (' + i + ')' + name.slice(dot) : name + ' (' + i + ')'; i++; }
    used.add(n);
    return n;
  }

  function save(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  // ── 일하기 ──
  async function run(id) {
    if (id === 'pages') return openEditor();
    if (busy) return;
    busy = true;
    clearResults();
    actionsEl.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const problems = [];
    const notes = [];
    try {
      const imgs = items.filter(isImg);
      if (id === 'merge') {
        const m = await window.TukPdf.merge(items.filter(isPdf).map((x) => x.file), setStatus);
        addResult(m.name, m.blob, m.pages + '쪽 · ' + size(m.blob.size));
      } else if (id === 'tojpg') {
        const hs = items.filter(isHeic);
        for (let i = 0; i < hs.length; i++) {
          const f = hs[i].file;
          setStatus('JPG로 바꾸는 중… ' + (i + 1) + '/' + hs.length);
          try {
            const j = await toJpeg(f, 0, 0.9);
            addResult(stem(f.name) + '.jpg', new Blob([j.bytes], { type: 'image/jpeg' }), size(j.bytes.length));
          } catch (e) { problems.push(f.name + ': ' + why(e)); }
        }
      } else if (id === 'split' || id === 'pdfjpg') {
        const pdfFiles = items.filter(isPdf).map((x) => x.file);
        // PDF 하나가 망가져도 나머지는 계속한다
        for (const f of pdfFiles) {
          try {
            const made = await (id === 'split' ? window.TukPdf.split([f], setStatus) : window.TukPdf.toJpg([f], setStatus));
            for (const r of made) addResult(r.name, r.blob);
          } catch (e) { problems.push(why(e)); }
        }
      } else if (id === 'pdf') {
        for (let i = 0; i < imgs.length; i++) {
          setStatus('PDF로 바꾸는 중… ' + (i + 1) + '/' + imgs.length);
          try { addResult(stem(imgs[i].file.name) + '.pdf', await imagesToPdf([imgs[i].file])); }
          catch (e) { problems.push(imgs[i].file.name + ': ' + why(e)); }
        }
      } else if (id === 'pdfall') {
        setStatus('PDF 하나로 묶는 중…');
        addResult(stem(imgs[0].file.name) + '_묶음.pdf', await imagesToPdf(imgs.map((x) => x.file), (i) => setStatus('PDF 하나로 묶는 중… ' + (i + 1) + '/' + imgs.length)));
      } else if (id === 'shrink') {
        let before = 0, after = 0, done = 0;
        for (let i = 0; i < imgs.length; i++) {
          const f = imgs[i].file;
          setStatus('용량 줄이는 중… ' + (i + 1) + '/' + imgs.length);
          try {
            const j = await toJpeg(f, shrinkSide, 0.8);
            if (HEIC.includes(ext(f.name))) {
              // 아이폰 사진은 JPG가 더 커도 바꾼다 (어디서나 열리게)
              addResult(stem(f.name) + '_줄임.jpg', new Blob([j.bytes], { type: 'image/jpeg' }), 'HEIC → JPG · ' + size(j.bytes.length));
              continue;
            }
            if (j.bytes.length >= f.size) { notes.push(f.name + '은(는) 이미 충분히 작아요'); continue; }
            addResult(stem(f.name) + '_줄임.jpg', new Blob([j.bytes], { type: 'image/jpeg' }), size(f.size) + ' → ' + size(j.bytes.length));
            before += f.size; after += j.bytes.length; done++;
          } catch (e) { problems.push(f.name + ': ' + why(e)); }
        }
        if (done > 1) notes.unshift(done + '장 합계 ' + size(before) + ' → ' + size(after));
      } else if (id === 'zip') {
        setStatus('ZIP으로 묶는 중…');
        const zip = new JSZip();
        for (const it of items) zip.file(it.path, it.file, { date: new Date(it.file.lastModified || Date.now()) });
        const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
          (m) => setStatus('ZIP으로 묶는 중… ' + Math.round(m.percent) + '%'));
        const tops = [...new Set(items.map(topName))];
        let name = tops.length === 1 && items.length > 1 ? tops[0] : stem(tops[0]);
        if (tops.length > 1) name += ' 외 ' + (tops.length - 1) + '개';
        addResult(name + '.zip', blob);
      } else if (id === 'unzip') {
        for (const it of items) {
          setStatus(it.file.name + ' 푸는 중…');
          try {
            const zip = await JSZip.loadAsync(it.file, { decodeFileName });
            const files = Object.values(zip.files).filter((f) => !f.dir);
            if (files.length === 0) notes.push(it.file.name + ' 안에 파일이 없어요');
            for (const f of files) addResult(stem(it.file.name) + '/' + f.name.replace(/^\/+/, ''), await f.async('blob'));
          } catch (e) { problems.push(it.file.name + ': ' + why(e)); }
        }
      }
    } catch (e) {
      problems.push(why(e));
    } finally {
      busy = false;
      actionsEl.querySelectorAll('button').forEach((b) => (b.disabled = false));
    }
    const head = results.length > 0
      ? (problems.length ? '일부만 됐어요. ' : '다 됐어요. ') + results.length + '개를 만들었어요.'
      : '만든 파일이 없어요.';
    setStatus([head].concat(notes, problems).join(' · '), problems.length > 0 && results.length === 0);
    resultBar.hidden = results.length === 0;
    $('#zipAll').hidden = results.length < 2;
  }

  function why(e) {
    if (e && e.name === 'EncodingError') return '그림 파일이 손상됐거나 읽을 수 없는 형식이에요';
    if (e && e.name === 'NotReadableError') return '파일을 읽지 못했어요. 다른 프로그램이 쓰고 있지 않은지 확인해 주세요';
    if (e && /corrupted zip|end of central directory/i.test(e.message || '')) return '압축 파일이 손상됐거나 ZIP 형식이 아니에요';
    return (e && e.message) || String(e);
  }

  // UTF-8 표시가 없는 ZIP 이름은 윈도우·알집이 흔히 쓰는 CP949(EUC-KR)로 읽는다
  function decodeFileName(bytes) {
    const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u); }
    catch (_) { return new TextDecoder('euc-kr').decode(u); }
  }

  // ── 그림 ──
  async function decode(file) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch (_) {
      // createImageBitmap이 못 읽는 형식(일부 BMP 등)은 <img>로 다시 시도
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.decoding = 'async';
        img.src = url;
        await img.decode();
        return img;
      } catch (e) {
        // 아이폰 사진(HEIC)은 사파리만 읽는다
        if (HEIC.includes(ext(file.name))) throw new Error('이 브라우저는 아이폰 사진(HEIC)을 읽지 못해요. 사파리에서 열거나 윈도우 프로그램을 써 주세요');
        throw e;
      } finally { URL.revokeObjectURL(url); }
    }
  }

  /** 흰 바탕 위에 다시 그려 JPEG로. maxSide 0이면 크기 그대로(단, 아주 큰 그림은 4000픽셀로 맞춤). */
  async function toJpeg(file, maxSide, quality) {
    const src = await decode(file);
    let w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
    const limit = maxSide || 4000;
    if (Math.max(w, h) > limit) {
      const s = limit / Math.max(w, h);
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, w, h);
    if (src.close) src.close();
    const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('그림을 만들지 못했어요'))), 'image/jpeg', quality));
    c.width = c.height = 0;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
  }

  // ── PDF (그림마다 A4 한 쪽, 가로 그림은 가로 쪽) ──
  async function imagesToPdf(files, progress) {
    const A4W = 595.28, A4H = 841.89, M = 28;
    const enc = new TextEncoder();
    const parts = [];
    const off = {};
    let pos = 0;
    const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); pos += b.length; };
    const n = (v) => (Math.round(v * 1000) / 1000).toString();

    put('%PDF-1.4\n');
    put(new Uint8Array([37, 226, 227, 207, 211, 10]));
    off[1] = pos; put('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    let next = 3;
    const kids = [];
    for (let i = 0; i < files.length; i++) {
      if (progress) progress(i);
      const { bytes, w, h } = await toJpeg(files[i], 0, 0.9);
      const land = w > h;
      const pw = land ? A4H : A4W, ph = land ? A4W : A4H;
      const s = Math.min((pw - 2 * M) / w, (ph - 2 * M) / h);
      const dw = w * s, dh = h * s, x = (pw - dw) / 2, y = (ph - dh) / 2;
      const imgId = next++, cId = next++, pId = next++;
      off[imgId] = pos;
      put(imgId + ' 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + w + ' /Height ' + h +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + bytes.length + ' >>\nstream\n');
      put(bytes);
      put('\nendstream\nendobj\n');
      const content = 'q ' + n(dw) + ' 0 0 ' + n(dh) + ' ' + n(x) + ' ' + n(y) + ' cm /Im0 Do Q\n';
      off[cId] = pos;
      put(cId + ' 0 obj\n<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream\nendobj\n');
      off[pId] = pos;
      put(pId + ' 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + n(pw) + ' ' + n(ph) + '] /Resources << /XObject << /Im0 ' +
        imgId + ' 0 R >> >> /Contents ' + cId + ' 0 R >>\nendobj\n');
      kids.push(pId);
    }
    off[2] = pos;
    put('2 0 obj\n<< /Type /Pages /Count ' + kids.length + ' /Kids [' + kids.map((k) => k + ' 0 R').join(' ') + '] >>\nendobj\n');
    const xref = pos;
    let t = 'xref\n0 ' + next + '\n0000000000 65535 f \n';
    for (let i = 1; i < next; i++) t += String(off[i]).padStart(10, '0') + ' 00000 n \n';
    t += 'trailer\n<< /Size ' + next + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    put(t);
    return new Blob(parts, { type: 'application/pdf' });
  }

  // ── 받기 카드: version.json에서 버전·크기를 읽는다 ──
  fetch('version.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((v) => {
      if (!v || !v.version) return;
      $('#ver').textContent = v.version;
      const bits = ['윈도우 10·11', '관리자 권한 없이 설치', '무료'];
      if (v.zipBytes) bits.unshift('ZIP ' + size(v.zipBytes));
      if (v.date) bits.push(v.date + ' 업데이트');
      $('#verMeta').textContent = bits.join(' · ');
    })
    .catch(() => {});

  if (typeof JSZip === 'undefined') {
    setStatus('ZIP 기능을 불러오지 못했어요. 인터넷 연결을 확인하고 새로 고쳐 주세요. (PDF·용량 줄이기는 돼요)', true);
  }
  render();
})();
