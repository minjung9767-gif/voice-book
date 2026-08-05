/* 우리 목소리 책 — 서비스워커
 * 앱 껍데기(HTML/CSS/JS/아이콘)를 캐시해서 오프라인에서도 열리고,
 * 홈화면 앱(PWA)으로 설치되게 한다.
 * 파일을 크게 바꾸면 아래 CACHE 버전 숫자를 올리면 새로 받아온다.
 */
const CACHE = "voicebook-v4";
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

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 폰트 등 외부는 브라우저에 맡김

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});
