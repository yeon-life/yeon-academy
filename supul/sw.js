// 수풀AI 서비스 워커 — 2026-05-08 v5 (4단계 권한·6자리 코드 분리 — 분점 공유 안전)
const CACHE = 'supul-ai-v5-20260513-4tier';
const ASSETS = [
  '/yeon-academy/supul/',
  '/yeon-academy/supul/index.html',
  '/yeon-academy/supul/teacher.html',
  '/yeon-academy/supul/manifest.json',
  '/yeon-academy/supul/icon-192.png',
  '/yeon-academy/supul/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  // 네트워크 우선 → 실패 시 캐시 (앱 신규 배포가 즉시 반영됨)
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
