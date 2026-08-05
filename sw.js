/* 별밤책 — 서비스워커
 * 온라인일 땐 항상 최신 파일을 먼저 받아오고(network-first),
 * 오프라인일 때만 캐시로 보여준다. → 업데이트가 폰에 바로 반영된다.
 * 파일을 크게 바꾸면 아래 CACHE 버전 숫자를 올린다.
 */
const CACHE = "voicebook-v17";
const CORE = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./scripts-data.js",
  "./analytics.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// network-first: 최신을 먼저, 실패(오프라인)하면 캐시
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 폰트 등 외부는 브라우저에 맡김

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
