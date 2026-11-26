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
  // 그림 → PDF 여백 (포인트): 보통 28(약 1cm) · 좁게 10 · 없음 0
  const MARGINS = [[28, '여백 보통'], [10, '여백 좁게'], [0, '여백 없이']];
  let pdfMargin = 28;
  try { const v = localStorage.getItem('tuk.pdfMargin'); if (v !== null && MARGINS.some(([m]) => m === Number(v))) pdfMargin = Number(v); } catch (_) { /* 저장 못 해도 괜찮다 */ }

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

  // ── 카메라로 찍기 (휴대폰·태블릿) ──
  // 찍을 때마다 목록에 더한다. 이름이 늘 image.jpg라서 찍은 순서대로 이름을 붙인다.
  const camera = $('#camera');
  let shots = 0;
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) $('#more').hidden = false;
  $('#camBtn').addEventListener('click', () => camera.click());
  camera.addEventListener('change', () => {
    const f = camera.files && camera.files[0];
    camera.value = '';
    if (!f || busy) return;
    shots++;
    const name = '찍은사진_' + String(shots).padStart(2, '0') + '.' + (ext(f.name) || 'jpg');
    const kept = items.filter(isImg);
    setItems(kept.concat([{ file: new File([f], name, { type: f.type || 'image/jpeg', lastModified: Date.now() }), path: name }]));
    setStatus(kept.length + 1 + '장이에요. 더 찍거나, 아래에서 PDF로 묶으세요.');
  });

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
  // ── 붙여넣기 (Ctrl+V): 화면 캡처한 그림이나 탐색기에서 복사한 파일 ──
  // 그림은 지금 목록의 그림 뒤에 더하고 (여러 번 붙여 넣어 묶기), 그 밖의 파일은 새로 올린다.
  let pasted = 0;
  const finePointer = !(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  if (finePointer) drop.querySelector('span').textContent += ' · Ctrl+V로 붙여넣기';
  document.addEventListener('paste', (e) => {
    const t = e.target;
    if (t && (t.closest('input, textarea, select, [contenteditable="true"]'))) return;
    const files = e.clipboardData ? [...e.clipboardData.files] : [];
    if (!files.length || busy) return;
    e.preventDefault();
    const now = new Date();
    const hhmmss = [now.getHours(), now.getMinutes(), now.getSeconds()].map((n) => String(n).padStart(2, '0')).join('');
    const named = files.map((f) => {
      // 캡처한 그림은 이름이 늘 image.png라서 겹치지 않게 이름을 붙인다
      if (!f.name || /^image\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name)) {
        pasted++;
        const nm = '붙여넣은그림_' + hhmmss + '_' + String(pasted).padStart(2, '0') + '.' + ((f.type.split('/')[1] || 'png').replace('jpeg', 'jpg'));
        return { file: new File([f], nm, { type: f.type || 'image/png', lastModified: now.getTime() }), path: nm };
      }
      return { file: f, path: f.name };
    });
    if (named.every(isImg)) {
      const kept = items.filter(isImg);
      setItems(kept.concat(named));
      setStatus('붙여 넣었어요. 그림 ' + (kept.length + named.length) + '장이에요. 더 붙여 넣거나 아래에서 고르세요.');
    } else {
      setItems(named);
    }
    const web = document.getElementById('web');
    if (web && web.getBoundingClientRect().top > window.innerHeight) web.scrollIntoView();
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
  function closeEditor() {
    if (editor) { const e = editor; editor = null; e.close(); }
    const o = document.querySelector('#opts');
    if (o) { o.hidden = true; o.innerHTML = ''; }
  }

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
    if (pdfs > 0) choices.push(['pagenum', '쪽 번호 넣기']);
    if (pdfs > 0) choices.push(['wm', '워터마크 넣기']);
    if (pdfs > 0) choices.push(['squeeze', 'PDF 용량 줄이기 (스캔본)']);
    if (pdfs > 0) choices.push(['split', '쪽마다 나누기']);
    if (pdfs > 0) choices.push(['pdfjpg', 'PDF → JPG 그림']);
    if (imgs > 0) choices.push(['pdf', imgs > 1 ? '그림마다 PDF로' : 'PDF로']);
    if (imgs > 1) choices.push(['pdfall', 'PDF 하나로 묶기 (' + imgs + '장)']);
    if (imgs > 1) choices.push(['arrange', '순서 정해서 묶기']);
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
        actionsEl.appendChild(pair(b, '줄일 크기', SIZES, shrinkSide, (v) => { shrinkSide = v; remember('shrinkSide', v); }));
      } else if (id === 'pdf') {
        // 여백은 'PDF로'와 'PDF 하나로 묶기'에 함께 쓴다
        actionsEl.appendChild(pair(b, 'PDF 여백', MARGINS, pdfMargin, (v) => { pdfMargin = v; remember('pdfMargin', v); }));
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

  /** 단추와 고르기를 한 덩어리로 */
  function pair(button, label, options, current, changed) {
    const g = document.createElement('span');
    g.className = 'pair';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', label);
    for (const [v, text] of options) {
      const o = document.createElement('option');
      o.value = String(v); o.textContent = text; o.selected = v === current;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => changed(Number(sel.value)));
    g.append(button, sel);
    return g;
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
    shareBtn.hidden = true;
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
    updateShare();
  }

  // ── 공유하기 (휴대폰의 공유 창: 카카오톡·메일 등) ──
  // 파일은 이 기기 안에서 공유 창으로만 넘어가고, 툭은 어디로도 보내지 않는다.
  const shareBtn = $('#shareAll');
  const asFiles = (list) => list.map((r) => new File([r.blob], r.name.split('/').pop(), { type: r.blob.type || 'application/octet-stream' }));
  function canShare(list) {
    try { return list.length > 0 && !!navigator.canShare && navigator.canShare({ files: asFiles(list) }); } catch (_) { return false; }
  }
  function updateShare() {
    const ok = results.length <= 10 && canShare(results);
    shareBtn.hidden = !ok;
    shareBtn.textContent = results.length > 1 ? results.length + '개 공유하기' : '공유하기';
  }
  shareBtn.addEventListener('click', async () => {
    try { await navigator.share({ files: asFiles(results) }); }
    catch (e) { if (!e || e.name !== 'AbortError') setStatus('공유하지 못했어요. 받기를 눌러 저장해 주세요.', true); }
  });

  $('#clear').addEventListener('click', () => { closeEditor(); items = []; clearResults(); render(); });

  // ── PDF 쪽 고르기 ──
  async function openEditor(photos) {
    if (busy || editor) return;
    closeOptions();
    busy = true;
    clearResults();
    actionsEl.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      editor = await window.TukPdf.edit(items.filter(photos ? isImg : isPdf).map((x) => x.file), pagesEl, {
        status: setStatus,
        images: photos ? (list) => imagesToPdf(list, (i) => setStatus('PDF 만드는 중… ' + (i + 1) + '/' + list.length)) : undefined,
        done: (blob, name, note) => {
          for (const r of results) if (r.url) URL.revokeObjectURL(r.url);
          results = []; resultsEl.innerHTML = '';
          shareBtn.hidden = true;
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
  // ── 쪽 번호·워터마크 고르기 ──
  const optsEl = $('#opts');
  const FORMS = {
    pagenum: {
      title: '쪽 번호 넣기',
      html:
        '<label>위치 <select name="where"><option value="bc">아래 가운데</option><option value="br">아래 오른쪽</option><option value="tr">위 오른쪽</option></select></label>' +
        '<label>모양 <select name="style"><option value="n">1</option><option value="nt">1 / 10</option><option value="dash">- 1 -</option></select></label>' +
        '<label>시작 번호 <input name="start" type="number" min="0" max="9999" value="1" inputmode="numeric"></label>' +
        '<label class="check"><input name="skipFirst" type="checkbox"> 첫 쪽(표지)은 빼고 세기</label>',
      read: (f) => ({ where: f.where.value, style: f.style.value, start: Math.max(0, Math.min(9999, parseInt(f.start.value, 10) || 1)), skipFirst: f.skipFirst.checked }),
      run: (files, o) => window.TukPdf.pageNumbers(files, o, setStatus),
    },
    wm: {
      title: '워터마크 넣기',
      html:
        '<label class="wide">글씨 <input name="text" type="text" maxlength="40" value="외부 유출 금지" required></label>' +
        '<label>진하기 <select name="alpha"><option value="0.12">연하게</option><option value="0.2" selected>보통</option><option value="0.32">진하게</option></select></label>' +
        '<label>방향 <select name="diagonal"><option value="1">대각선</option><option value="0">가로</option></select></label>',
      read: (f) => ({ text: f.text.value.trim(), alpha: Number(f.alpha.value), diagonal: f.diagonal.value === '1' }),
      run: (files, o) => window.TukPdf.watermark(files, o, setStatus),
    },
    squeeze: {
      title: 'PDF 용량 줄이기 (스캔본)',
      submit: '줄이기',
      html:
        '<label>화질 <select name="level"><option value="s">작게 · 100dpi</option><option value="m" selected>보통 · 150dpi</option><option value="l">선명하게 · 200dpi</option></select></label>' +
        '<p class="opts-note">스캔한(그림으로 된) 쪽만 줄여요. 글자로 된 쪽은 그대로 둬서 글자 고르기·검색이 그대로 돼요.</p>',
      read: (f) => ({ level: f.level.value }),
      run: (files, o) => window.TukPdf.squeeze(files, { s: { dpi: 100, quality: 0.6 }, m: { dpi: 150, quality: 0.7 }, l: { dpi: 200, quality: 0.8 } }[o.level] || { dpi: 150, quality: 0.7 }, setStatus),
    },
  };
  // 고른 값은 이 브라우저에만 기억한다
  function remember(k, v) { try { localStorage.setItem('tuk.' + k, JSON.stringify(v)); } catch (_) { /* 무시 */ } }
  const recall = (k) => { try { return JSON.parse(localStorage.getItem('tuk.' + k) || 'null'); } catch (_) { return null; } };

  function showOptions(id) {
    const def = FORMS[id];
    optsEl.hidden = false;
    optsEl.innerHTML = '<form class="opts-form"><b class="opts-title"></b><div class="opts-fields">' + def.html + '</div>' +
      '<div class="bar"><button class="btn primary" type="submit">PDF ' + items.filter(isPdf).length + '개' + (def.submit ? ' ' + def.submit : '에 넣기') + '</button>' +
      '<button class="btn small" type="button" data-act="close">닫기</button></div></form>';
    const form = optsEl.querySelector('form');
    optsEl.querySelector('.opts-title').textContent = def.title;
    const saved = recall(id);
    if (saved) for (const [k, v] of Object.entries(saved)) {
      const el = form.elements[k];
      if (!el || (k === 'text' && !v)) continue;
      if (el.type === 'checkbox') el.checked = !!v;
      else el.value = typeof v === 'boolean' ? (v ? '1' : '0') : String(v);
    }
    form.querySelector('[data-act="close"]').addEventListener('click', closeOptions);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const o = def.read(form.elements);
      if (id === 'wm' && !o.text) { setStatus('워터마크 글씨를 적어 주세요', true); return; }
      remember(id, o);
      busy = true;
      form.querySelectorAll('button').forEach((b) => (b.disabled = true));
      clearResults();
      const problems = [], notes = [];
      for (const it of items.filter(isPdf)) {
        try {
          for (const r of await def.run([it.file], o)) {
            if (r.message) notes.push(r.message);
            else addResult(r.name, r.blob, r.note);
          }
        } catch (err) { problems.push(why(err)); }
      }
      busy = false;
      form.querySelectorAll('button').forEach((b) => (b.disabled = false));
      const head = results.length ? (problems.length ? '일부만 됐어요. ' : '다 됐어요. ') + results.length + '개를 만들었어요.' : '만든 파일이 없어요.';
      setStatus([head].concat(notes, problems).join(' · '), problems.length > 0 && results.length === 0);
      resultBar.hidden = results.length === 0;
      $('#zipAll').hidden = results.length < 2;
    });
    optsEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    form.querySelector('input, select').focus();
  }
  function closeOptions() { optsEl.hidden = true; optsEl.innerHTML = ''; }

  async function run(id) {
    if (FORMS[id]) return showOptions(id);
    if (id === 'pages') return openEditor(false);
    if (id === 'arrange') return openEditor(true);
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
  async function toJpeg(file, maxSide, quality, rot) {
    const src = await decode(file);
    let w = src.width || src.naturalWidth, h = src.height || src.naturalHeight;
    const turn = (((rot || 0) % 360) + 360) % 360;
    const limit = maxSide || 4000;
    if (Math.max(w, h) > limit) {
      const s = limit / Math.max(w, h);
      w = Math.max(1, Math.round(w * s));
      h = Math.max(1, Math.round(h * s));
    }
    // 돌리면 가로·세로가 바뀐다
    const cw = turn % 180 ? h : w, ch = turn % 180 ? w : h;
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, cw, ch);
    g.imageSmoothingQuality = 'high';
    g.translate(cw / 2, ch / 2);
    g.rotate(turn * Math.PI / 180);
    g.drawImage(src, -w / 2, -h / 2, w, h);
    if (src.close) src.close();
    const blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('그림을 만들지 못했어요'))), 'image/jpeg', quality));
    c.width = c.height = 0;
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w: cw, h: ch };
  }

  // ── PDF (그림마다 A4 한 쪽, 가로 그림은 가로 쪽) ──
  async function imagesToPdf(files, progress) {
    const A4W = 595.28, A4H = 841.89, M = pdfMargin;
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
      // files: File 또는 {file, rot} (순서 정하기에서 돌린 사진)
      const one = files[i] instanceof Blob ? { file: files[i], rot: 0 } : files[i];
      const { bytes, w, h } = await toJpeg(one.file, 0, 0.9, one.rot);
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

  // ── 앱으로 설치 · 인터넷 없이 쓰기 ──
  // 서비스 워커는 툭 화면과 라이브러리만 담아 둔다. 파일은 담지 않는다.
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  const installBtn = $('#installBtn');
  let installEvent = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    installBtn.hidden = false;
  });
  installBtn.addEventListener('click', async () => {
    if (!installEvent) return;
    const e = installEvent; installEvent = null;
    installBtn.hidden = true;
    try { await e.prompt(); } catch (_) { /* 무시 */ }
  });
  window.addEventListener('appinstalled', () => { installBtn.hidden = true; installEvent = null; });
  if (!standalone && /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios|edgios/i.test(navigator.userAgent)) $('#iosHint').hidden = false;

  // ── 다른 앱에서 공유로 받은 파일 (안드로이드에 설치했을 때) ──
  async function takeShared() {
    if (!/[?&]shared=1/.test(location.search)) return;
    history.replaceState(null, '', location.pathname + '#web');
    if (!window.caches) return;
    try {
      const box = await caches.open('tuk-share');
      const keys = await box.keys();
      const list = [];
      for (const k of keys) {
        const r = await box.match(k);
        if (!r) continue;
        const name = decodeURIComponent(r.headers.get('X-Tuk-Name') || '받은파일');
        const blob = await r.blob();
        const file = new File([blob], name, { type: blob.type, lastModified: Number(r.headers.get('X-Tuk-Time')) || Date.now() });
        list.push({ file, path: name });
      }
      await caches.delete('tuk-share');
      if (!list.length) { setStatus('공유한 파일을 받지 못했어요. 여기에 다시 놓아 주세요.', true); return; }
      list.sort((a, b) => a.path.localeCompare(b.path, 'ko', { numeric: true }));
      setItems(list);
      setStatus(list.length + '개를 받았어요. 아래에서 할 일을 고르세요.');
      const web = document.getElementById('web');
      if (web) web.scrollIntoView();
    } catch (_) {
      setStatus('공유한 파일을 받지 못했어요. 여기에 다시 놓아 주세요.', true);
    }
  }

  if (typeof JSZip === 'undefined') {
    setStatus('ZIP 기능을 불러오지 못했어요. 인터넷 연결을 확인하고 새로 고쳐 주세요. (PDF·용량 줄이기는 돼요)', true);
  }
  render();
  takeShared();
})();
