/* 별밤책 — 서비스워커
 * 온라인일 땐 항상 최신 파일을 먼저 받아오고(network-first),
 * 오프라인일 때만 캐시로 보여준다. → 업데이트가 폰에 바로 반영된다.
 * 파일을 크게 바꾸면 아래 CACHE 버전 숫자를 올린다.
 */
const CACHE = "voicebook-v61";
const CORE = [
  "./",
  "./index.html",
  "./style.css?v=57",
  "./app.js?v=57",
  "./scripts-data.js?v=57",
  "./analytics.js?v=57",
  "./manifest.webmanifest?v=57",
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

/* network-first: 최신을 먼저, 실패(오프라인)하면 캐시.
 * ⚠️ 반드시 `cache: "no-store"` 로 받아야 한다.
 * 그냥 fetch(req) 하면 브라우저가 몰래 갖고 있던 사본(GitHub Pages는 10분)을 줄 수 있고,
 * 그러면 index.html 만 예전 것이고 app.js 는 새 것인 '반쪽 섞임'이 생겨 화면이 텅 빈다. */
const refreshed = new Set();   // 이번에 뒤에서 새로 받아 둔 그림 주소
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 폰트 등 외부는 브라우저에 맡김

  /* 🖼 동화 그림은 다르게: 기기에 저장해 둔 게 있으면 그걸 바로 보여주고(기다림 없음),
   * 뒤에서 몰래 새로 받아 저장해 둔다 → 그림 파일을 새 것으로 바꿔도 다음번엔 새 그림이 나온다.
   * (위의 network-first 를 그림에도 쓰면 앱을 열 때마다 그림을 인터넷에서 다시 받느라 늦게 뜬다.)
   * 뼈대 파일(index.html·app.js 등)은 '반쪽 섞임'을 막아야 하므로 아래 network-first 그대로 둔다. */
  if (url.pathname.includes("/assets/") && /\.(webp|png|jpe?g)$/i.test(url.pathname)) {
    const refresh = () => fetch(req.url, { cache: "no-store", credentials: "same-origin" }).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req.url, copy));
      }
      return res;
    });
    e.respondWith(
      caches.match(req.url).then((hit) => {
        if (hit) {
          // 뒤에서 새로 받기는 서비스워커가 깨어 있는 동안 그림마다 한 번만(데이터 아끼기)
          if (!refreshed.has(req.url)) { refreshed.add(req.url); e.waitUntil(refresh().catch(() => {})); }
          return hit;
        }
        return refresh();
      })
    );
    return;
  }

  e.respondWith(
    fetch(req.url, { cache: "no-store", credentials: "same-origin" })
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
