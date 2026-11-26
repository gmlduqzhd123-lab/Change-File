// 툭 서비스 워커: 한 번 열어 둔 툭을 인터넷 없이도 열 수 있게 이 기기에 담아 둔다.
// 파일은 어디로도 보내지 않는다. 다른 앱에서 '공유'로 받은 파일도 이 기기 안에만 잠깐 둔다.
'use strict';

const VERSION = 'tuk-2.5.0';
const SHELL = VERSION + '-shell';
const LIBS = 'tuk-libs';          // 버전이 주소에 박힌 라이브러리 — 바뀌지 않으니 계속 쓴다
const SHARE = 'tuk-share';        // 공유로 받은 파일을 화면이 꺼낼 때까지만 둔다

const BASE = new URL('./', self.location).href;
const PAGES = ['./', 'app.js', 'pdftools.js', 'crop.js', 'selftest.html', 'selftest-sample.heic', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const CDN = [
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(PAGES.map((p) => new Request(new URL(p, BASE).href, { cache: 'reload' })));
    // 라이브러리는 못 받아도 설치는 끝낸다 (쓸 때 다시 받는다)
    const libs = await caches.open(LIBS);
    await Promise.all(CDN.map(async (u) => {
      if (await libs.match(u)) return;
      try { const r = await fetch(u, { mode: 'cors', credentials: 'omit' }); if (r.ok) await libs.put(u, r); } catch (_) { /* 나중에 */ }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.endsWith('-shell') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // 다른 앱에서 공유한 파일 (안드로이드)
  if (req.method === 'POST' && url.href === new URL('share', BASE).href) {
    e.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;

  if (url.origin === 'https://cdnjs.cloudflare.com') {
    e.respondWith(cacheFirst(req));
    return;
  }
  if (url.origin !== self.location.origin || !url.href.startsWith(BASE)) return;
  // 프로그램 받기와 버전 정보는 늘 새로 (담아 두지 않는다)
  const rel = url.href.slice(BASE.length);
  if (rel.startsWith('download/') || rel.startsWith('version.json') || rel.startsWith('_t/')) return;
  e.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const libs = await caches.open(LIBS);
  const hit = await libs.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && (res.type === 'cors' || res.type === 'basic')) libs.put(req.url, res.clone());
  return res;
}

// 인터넷이 되면 늘 새 것을, 안 되면 담아 둔 것을
async function networkFirst(req) {
  const shell = await caches.open(SHELL);
  // 담아 둘 이름: 주소에서 ?…와 #…를 뗀 것. 첫 화면(./ 또는 index.html)은 './' 하나로.
  let key = req.url.split('#')[0].split('?')[0];
  if (key === BASE || key === BASE + 'index.html') key = new URL('./', BASE).href;
  try {
    // 브라우저가 10분쯤 받아 두는 것을 믿지 않고 늘 서버에 새 것인지 물어본다 (안 바뀌었으면 금방 끝난다)
    const res = await fetch(new Request(req.url, { cache: 'no-cache', credentials: 'same-origin', redirect: 'follow' }));
    if (res.ok && res.type === 'basic' && PAGES.some((p) => new URL(p, BASE).href === key)) {
      await shell.put(key, res.clone());
    }
    return res;
  } catch (err) {
    const hit = await shell.match(key, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && 'name' in f);
    await caches.delete(SHARE);
    const box = await caches.open(SHARE);
    let i = 0;
    for (const f of files.slice(0, 200)) {
      await box.put(new URL('share-item/' + (i++), BASE).href, new Response(f, {
        headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Tuk-Name': encodeURIComponent(f.name || '받은파일'), 'X-Tuk-Time': String(f.lastModified || Date.now()) },
      }));
    }
  } catch (_) { /* 받지 못했으면 화면이 그냥 비어 있다 */ }
  return Response.redirect(new URL('./?shared=1#web', BASE).href, 303);
}
