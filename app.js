/* =========================================================
 * 별밤책 — 앱 로직
 * ---------------------------------------------------------
 * 이야기 하나 = 여러 "장면". 장면마다 목소리를 하나씩 녹음한다.
 * 아기에게 들려줄 땐 장면 클립을 순서대로 이어 재생하고, 그림도 함께 넘어간다.
 * 한 편이 끝나면 다른 이야기로 저절로 이어진다(랜덤).
 *
 * 저장(IndexedDB `voicebook` / store `recordings`, 서버 없음):
 *   - 장면 클립 : `${storyId}:v2:${voice}:${장면번호}`   ← 지금 방식
 *   - 예전 녹음 : `${storyId}:${voice}`                  ← 옛 버전(이야기 통째로 하나)
 *   두 가지가 한 창고에 같이 있고, 예전 녹음은 지우지 않는다.
 *   예전 녹음만 있는 이야기는 '예전 녹음'으로 그대로 들을 수 있다.
 *
 * 화면: 홈(아기용 그림 카드) · 이야기 고르기(부모용) · 녹음(부모용) · 들려주기(아기용)
 *   - 홈은 아기 화면이다. 카드 순서는 대본 순서 그대로 절대 안 바뀐다
 *     (아기가 "세 번째 칸이 돼지 이야기"처럼 자리로 기억하기 때문).
 *   - 녹음은 홈 맨 아래 '🎙 녹음하기'로 한 단계 들어가야 나온다.
 *
 * 목소리: 예전에는 엄마·아빠를 따로 녹음했지만 지금은 한 명만 녹음한다.
 *   이미 해 둔 녹음을 버리지 않으려고, 이야기마다 장면이 더 많이 녹음된 쪽을 쓴다
 *   (수가 같으면 아빠). 안 쓰는 쪽도 지우지 않고 그대로 둔다.
 * ========================================================= */
(() => {
  "use strict";

  const VOICE_LABEL = { mom: "엄마", dad: "아빠" };   // 저장 열쇠에 쓰이는 이름(화면에는 안 보임)
  const DEFAULT_VOICE = "mom";                       // 이 폰의 주인을 아직 안 정했을 때만 쓰는 값

  /* 이 폰의 주인(누가 녹음하는 사람인지).
   * 부부가 각자 폰에서 녹음한 뒤 백업 파일을 주고받는 게 이 앱의 핵심인데,
   * 두 사람이 같은 칸에 녹음하면 복원할 때 한쪽이 덮어써져 사라진다.
   * 그래서 폰마다 주인을 정해 두고, 새 녹음은 늘 그 사람 칸에 담는다. */
  function getMyVoice() {
    try { const v = localStorage.getItem("myVoice"); return VOICE_LABEL[v] ? v : null; } catch (e) { return null; }
  }
  function setMyVoice(v) { try { localStorage.setItem("myVoice", v); } catch (e) {} }
  const myVoice = () => getMyVoice() || DEFAULT_VOICE;
  const APP_VERSION = "v36";
  const STORE_VER = "v2";          // 장면 클립 키에 들어가는 방식 버전

  /* 🎁 앱을 다른 부모에게 알려줄 때 보내는 글.
   * ⚠️ 마지막 줄(사파리·크롬 안내)을 빼지 말 것 —
   *    카톡으로 받아 카톡 안에서 열면 녹음이 따로 저장돼 나중에 "사라진 것처럼" 보인다. */
  const SHARE_URL = "https://minjung9767-gif.github.io/voice-book/";
  const SHARE_BODY =                       // 주소를 뺀 소개 글 (공유할 땐 주소를 따로 실어 보낸다)
    "🌙 별밤책 — 엄마·아빠 목소리로 읽어주는 아기 잠자리 그림책\n\n" +
    "우리 아기한테 들려줄 동화를 직접 녹음해서 재생할 수 있어요.\n" +
    "녹음은 내 폰 안에만 저장돼서 안심이에요. 무료고 설치도 필요 없어요!\n\n" +
    "※ 카톡 안에서 바로 열면 녹음이 저장 안 될 수 있어요. 사파리·크롬으로 열어주세요 🙏";
  const SHARE_TEXT = SHARE_BODY + "\n\n" + SHARE_URL;   // 복사해서 붙여 넣을 때 쓰는 전체 글

  /* 의견 받는 곳 — 구글 폼
   * 사용자는 앱 안의 예쁜 폼에 쓰고, 내용은 조용히 구글 폼으로 넘어가 스프레드시트에 쌓인다.
   * 아래 세 값은 민정이 만든 구글 폼에서 가져온다 (만드는 법: ROADMAP "의견 받기" 참고).
   *   id      : https://docs.google.com/forms/d/e/○○○○○/viewform 의 ○○○○○
   *   message : 내용 칸의 entry 번호  (예: "entry.1234567890")
   *   email   : 이메일 칸의 entry 번호
   * 비워 두면 예전 방식(Netlify Forms)으로 보낸다. */
  const FEEDBACK_FORM = {
    id: "1FAIpQLSe4knTjkDXzTtPgLFAeuDw-q7VwJSx-LaWzlUd08exci1d9Fg",
    message: "entry.532879545",
    email: "entry.1819893667",
  };

  const $ = (id) => document.getElementById(id);
  const STORIES = window.SCRIPTS;

  const homeEl = $("home"), pickEl = $("pick"), recEl = $("rec"), playEl = $("play");
  const gridEl = $("storyGrid"), pickListEl = $("pickList"), footNote = $("footNote");
  const shuffleBtn = $("shuffleBtn"), emptyNote = $("emptyNote"), installBar = $("installBar");
  const nameChip = $("nameChip"), nameOwner = $("nameOwner");
  const recTitleEl = $("recTitle"), recProgEl = $("recProg"), recBottomEl = $("recBottom");
  const recArtEl = $("recArt"), recTextEl = $("recText"), legacyNoteEl = $("legacyNote");
  const playStageEl = $("playStage"), playArtEl = $("playArt"), playTextEl = $("playText"), pauseOvEl = $("pauseOv");
  const modalEl = $("modal"), modalBody = $("modalBody");
  const restoreInput = $("restoreInput"), toastEl = $("toast");

  /* ===== 반쪽 섞임 막기 · 자가 복구 =====
   * 앱은 뼈대(index.html) · 모양(style.css) · 로직(app.js) · 대본(scripts-data.js) 넷으로 돈다.
   * 폰이 이 중 일부만 예전 것으로 가져오면 화면이 깨지거나 텅 빈다. 실제로 그런 일이 있었다.
   *   - v24: 예전 index.html + 새 app.js  → 찾는 자리가 없어 목록이 안 그려짐
   *   - v25: 예전 style.css + 새 index.html → 목록 칸이 납작해져 버튼이 위로 올라붙음
   *
   * 1차 방어(진짜 해결책): index.html 이 파일들을 `style.css?v=26` 처럼 **버전을 붙여** 부른다.
   *   주소가 달라지므로 예전 사본이 절대 안 끼어든다. 새 버전을 낼 땐 네 곳을 같이 올린다 —
   *   index.html(data-v) · style.css(--v) · app.js(APP_VERSION) · sw.js(CACHE).
   * 2차 방어(안전망): 그래도 판이 어긋나면 캐시를 비우고 딱 한 번 새로고침해 스스로 고친다. */
  function stampOf(el, attr) { try { return (el.getAttribute(attr) || "").trim(); } catch (e) { return ""; } }
  function cssStamp() {
    try { return getComputedStyle(document.documentElement).getPropertyValue("--v").replace(/["'\s]/g, ""); }
    catch (e) { return ""; }
  }
  function versionsMatch() {
    if (stampOf(document.documentElement, "data-v") !== APP_VERSION) return false;   // 뼈대가 딴 판
    if (cssStamp() !== APP_VERSION) return false;                                    // 모양이 딴 판
    if (!Array.isArray(STORIES) || !STORIES.length || !STORIES[0].scenes) return false; // 대본이 딴 판
    // 뼈대에 있어야 할 자리들이 실제로 있는지도 확인
    if (document.querySelectorAll(".vtab").length !== 2) return false;
    return [gridEl, pickListEl, shuffleBtn, emptyNote, installBar, $("shareBtn"), $("recEntry"), $("playHome"), $("recBack"), $("pickHome")]
      .every((el) => !!el);
  }
  function recoverFromMixedVersion() {
    try {
      if (sessionStorage.getItem("mixFix") === "1") return;   // 한 번만 (무한 새로고침 방지)
      sessionStorage.setItem("mixFix", "1");
    } catch (e) { return; }
    const again = () => location.reload();
    const jobs = [];
    if (window.caches && caches.keys) jobs.push(caches.keys().then((ks) => Promise.all(ks.map((k) => caches.delete(k)))));
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      jobs.push(navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister()))));
    }
    Promise.all(jobs).then(again, again);
  }
  if (!versionsMatch()) { recoverFromMixedVersion(); return; }
  try { sessionStorage.removeItem("mixFix"); } catch (e) {}   // 판이 맞으면 복구 기록은 지운다

  // 녹음 화면 상태
  const rec = {
    story: null, voice: DEFAULT_VOICE, scene: 0,
    done: new Set(),               // 이 이야기·이 목소리에서 녹음된 장면 번호
    hasLegacy: false,              // 예전(통) 녹음이 남아 있는지
    recorder: null, chunks: [], stream: null, recording: false,
    preview: null, previewOn: false,
    histMap: {},                   // { 장면번호: 지난 녹음 개수 }
  };
  // 들려주기 상태
  const pb = {
    story: null, voice: DEFAULT_VOICE, scene: 0, audio: null, url: null,
    state: "idle",                 // idle | playing | paused | ended
    mode: "scenes",                // scenes | legacy
    prog: {},                      // 지금 재생에 쓰는 녹음 현황
    list: [], listIdx: 0,          // 이어 들려줄 차례표(섞인 이야기 번호)와 현재 위치
    nextTimer: null,               // 한 편이 끝나고 다음 편으로 넘어가기까지의 여운
  };

  const storyByIdx = (i) => STORIES[i];
  /* 화면 바꾸기. 배경의 장식 달은 홈에서만 보이게 한다
   * (다른 화면에선 오른쪽 위 버튼과 겹쳐서 지저분해 보인다) */
  function setScreen(el) {
    [homeEl, pickEl, recEl, playEl].forEach((sc) => sc.classList.toggle("active", sc === el));
    document.body.classList.toggle("no-moon", el !== homeEl);
  }
  const sceneCount = (s) => s.scenes.length;

  /* ================= IndexedDB ================= */
  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("voicebook", 1);
      req.onupgradeneeded = () => { req.result.createObjectStore("recordings", { keyPath: "key" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  function store(mode) { return db().then((d) => d.transaction("recordings", mode).objectStore("recordings")); }
  async function dbGet(key) { const s = await store(); return new Promise((res, rej) => { const r = s.get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); }); }
  async function dbPut(v) { const s = await store("readwrite"); return new Promise((res, rej) => { const r = s.put(v); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
  async function dbAllKeys() { const s = await store(); return new Promise((res, rej) => { const r = s.getAllKeys(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }
  async function dbAll() { const s = await store(); return new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }

  async function dbDel(key) { const st = await store("readwrite"); return new Promise((res, rej) => { const r = st.delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }

  const sceneKey = (storyId, voice, i) => `${storyId}:${STORE_VER}:${voice}:${i}`;
  const legacyKey = (storyId, voice) => `${storyId}:${voice}`;

  /* ===== 지난 녹음(이력) =====
   * 다시 녹음해도 예전 것을 지우지 않고 `본래열쇠#h시각` 으로 옮겨 둔다.
   * "다시 녹음했는데 예전 게 더 좋았다"를 되돌릴 수 있게 하기 위함.
   * 장면마다 최근 HISTORY_KEEP 개까지만 남기고 오래된 건 조용히 정리한다
   * (무제한으로 쌓으면 백업 파일이 너무 커져서, 정작 백업이 못 쓰게 된다).
   * ⚠️ `#h` 뒤 부분 때문에 loadProgress 의 `split(":")` 검사에서 자동으로 걸러진다
   *    (장면 번호가 숫자가 아니게 되므로). 그래서 진행률에 섞여 들어가지 않는다. */
  const HISTORY_KEEP = 3;
  const histKey = (key, ts) => `${key}#h${ts}`;
  const isHistKey = (k) => String(k).indexOf("#h") > 0;
  const histOwner = (k) => String(k).slice(0, String(k).indexOf("#h"));
  const histTime = (k) => +String(k).slice(String(k).indexOf("#h") + 2) || 0;

  // 이 열쇠의 지난 녹음 열쇠들 (최근 것부터)
  async function histKeysOf(key) {
    let keys = [];
    try { keys = await dbAllKeys(); } catch (e) { return []; }
    return keys.filter((k) => isHistKey(k) && histOwner(k) === key).sort((a, b) => histTime(b) - histTime(a));
  }
  // 지금 녹음을 이력으로 밀어 넣고, 넘치는 건 정리한다
  async function pushHistory(key) {
    let cur = null;
    try { cur = await dbGet(key); } catch (e) {}
    if (!cur || !cur.blob) return;
    const ts = cur.createdAt || Date.now();
    let hk = histKey(key, ts);
    try { if (await dbGet(hk)) hk = histKey(key, ts + 1); } catch (e) {}
    try { await dbPut({ key: hk, blob: cur.blob, mime: cur.mime, createdAt: ts }); } catch (e) { return; }
    const all = await histKeysOf(key);
    for (const k of all.slice(HISTORY_KEEP)) { try { await dbDel(k); } catch (e) {} }
  }
  // "3분 전 · 어제 · 지난주" 처럼 쉬운 말로
  function agoText(ms) {
    if (!ms) return "언제인지 몰라요";
    const s2 = Math.max(0, Date.now() - ms) / 1000;
    if (s2 < 60) return "방금 전";
    if (s2 < 3600) return Math.floor(s2 / 60) + "분 전";
    if (s2 < 86400) return Math.floor(s2 / 3600) + "시간 전";
    const d = Math.floor(s2 / 86400);
    if (d === 1) return "어제";
    if (d < 7) return d + "일 전";
    if (d < 30) return Math.floor(d / 7) + "주 전";
    return Math.floor(d / 30) + "달 전";
  }

  // 모든 열쇠를 한 번에 훑어 이야기별 진행 상황을 만든다.
  //   → { [storyId]: { mom:Set(장면번호), dad:Set, momOld:bool, dadOld:bool } }
  async function loadProgress() {
    const map = {};
    const slot = (id) => (map[id] = map[id] || { mom: new Set(), dad: new Set(), momOld: false, dadOld: false });
    let keys = [];
    try { keys = await dbAllKeys(); } catch (e) { return map; }
    for (const raw of keys) {
      const p = String(raw).split(":");
      if (p.length === 4) {                                   // 장면 클립
        const [id, ver, v, idx] = [p[0], p[1], p[2], +p[3]];
        if (ver !== STORE_VER || !VOICE_LABEL[v] || !(idx >= 0)) continue;
        slot(id)[v].add(idx);
      } else if (p.length === 2) {                            // 예전 통 녹음
        const [id, v] = p;
        if (!VOICE_LABEL[v]) continue;
        slot(id)[v + "Old"] = true;
      }
    }
    return map;
  }
  const emptySlot = () => ({ mom: new Set(), dad: new Set(), momOld: false, dadOld: false });
  /* 이 이야기가 쓸 '목소리 자리' 하나를 고른다.
   * 엄마·아빠를 따로 녹음하던 시절의 녹음을 살리려고, 장면이 더 많이 담긴 쪽을 쓴다.
   * 수가 같으면 아빠 쪽. (안 쓰는 쪽 녹음도 지우지 않고 그대로 남는다) */
  function storyVoice(p) {
    if (!p) return myVoice();
    if (p.dad.size > p.mom.size) return "dad";
    if (p.mom.size > p.dad.size) return "mom";
    if (p.dad.size > 0) return "dad";
    if (p.dadOld) return "dad";
    if (p.momOld) return "mom";
    return myVoice();
  }
  // 이 이야기를 지금 들려줄 수 있나? "scenes"(장면 다 있음) | "legacy"(예전 녹음) | null
  function storyKind(p, story) {
    if (!p) return null;
    const v = storyVoice(p);
    if (p[v].size >= sceneCount(story)) return "scenes";
    if (p[v + "Old"]) return "legacy";
    return null;
  }

  /* ================= 유틸 ================= */
  // 홈 화면 앱으로 열렸는지 / 아이폰인지 — 여러 곳에서 쓰므로 일찍 정해 둔다
  const isStandalone = () =>
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS 포함
  const isAndroid = /Android/i.test(navigator.userAgent || "");

  let toastTimer = null;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function pickMime() {
    const cand = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg;codecs=opus"];
    if (window.MediaRecorder && MediaRecorder.isTypeSupported) { for (const t of cand) if (MediaRecorder.isTypeSupported(t)) return t; }
    return "";
  }
  function blobToDataURL(b) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); }); }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  /* ================= 아기 이름 ================= */
  function getBabyName() { try { return (localStorage.getItem("babyName") || "").trim(); } catch (e) { return ""; } }
  function hasBatchim(s) { const c = s.charCodeAt(s.length - 1); return c >= 0xAC00 && c <= 0xD7A3 && (c - 0xAC00) % 28 !== 0; }
  function josaUi(name) { return name + (hasBatchim(name) ? "이의" : "의"); }   // "민준이의" / "지우의"

  /* 대본 속 이름 자리 채우기
   *   {이름}   → (하준이) / (지우)      말할 때 쓰는 형태 ("하준이 손이 근질근질")
   *   {이름은} → (하준이)는 / (지우)는
   *   {이름이} → (하준이)가 / (지우)가
   *   {이름을} → (하준이)를 / (지우)를
   *   {이름아} → (하준)아 / (지우)야   부를 때 (이때만 '이'를 안 붙인다)
   * 받침 있는 이름엔 '이'를 붙이므로(하준 → 하준이) 조사는 늘 는/가/를이 된다.
   * 이름을 아직 안 넣었으면 "(아기 이름)은" 처럼 자리만 보여준다. */
  const NAME_JOSA = { "은": ["은", "는"], "이": ["이", "가"], "을": ["을", "를"] };
  function renderName(text) {
    const name = getBabyName();
    const shown = name || "아기 이름";
    const stem = name && hasBatchim(name) ? name + "이" : shown;
    const tag = (word, josa) => '<span class="nm">(' + escapeHtml(word) + ')' + josa + "</span>";
    return text.replace(/\{이름([아은이을]?)\}/g, (m, kind) => {
      if (kind === "아") return tag(shown, hasBatchim(shown) ? "아" : "야");
      if (!kind) return tag(stem, "");
      const pair = NAME_JOSA[kind];
      return tag(stem, hasBatchim(stem) ? pair[0] : pair[1]);
    });
  }
  // 이름이 있으면 제목 위에 "○○이의"(눌러서 수정), 없으면 아래 "아기 이름 정하기" 알약
  function updateNameUI() {
    const name = getBabyName();
    if (name) { nameOwner.textContent = josaUi(name) + " ✏️"; nameOwner.hidden = false; nameChip.hidden = true; }
    else { nameOwner.hidden = true; nameChip.hidden = false; }
  }
  // 이름을 바꾸면 지금 보이는 화면의 문장도 바로 갱신
  function refreshNameInText() {
    if (recEl.classList.contains("active")) paintRecScene(false);
    if (playEl.classList.contains("active")) paintPlayScene(false);
  }

  /* ================= 홈 하단 안내 한 줄 ================= */
  function hasBackedUp() { try { return !!localStorage.getItem("lastBackupAt"); } catch (e) { return false; } }
  function markBackedUp() { try { localStorage.setItem("lastBackupAt", String(Date.now())); } catch (e) {} updateFootNote(homeHasRecording); }
  let homeHasRecording = false;
  function updateFootNote(anyRecording) {
    if (typeof anyRecording === "boolean") homeHasRecording = anyRecording;
    if (homeHasRecording && !hasBackedUp()) {
      footNote.className = "privacy-note warn";
      footNote.innerHTML = "🛟 아직 <b>백업</b> 전이에요 — 더보기에서 백업해 주세요";
    } else {
      footNote.className = "privacy-note";
      footNote.innerHTML = "🔒 녹음은 <b>이 기기 안에만</b> 저장돼요";
    }
  }

  /* ================= 홈 화면 (아기용) =================
   * 그림 카드 2열. 순서는 대본 순서 그대로 — 녹음을 새로 해도 자리가 절대 안 바뀐다.
   * 아직 녹음이 없는 이야기는 흐릿하게, 자리는 그대로 지킨다. */
  let homeProg = {};
  async function renderHome() {
    try { await renderHomeInner(); }
    catch (e) {
      // 여기서 막히면 예전엔 화면이 통째로 비어 "이야기가 사라졌다"고 보였다. 이유를 보여준다.
      shuffleBtn.hidden = true; emptyNote.hidden = false;
      emptyNote.innerHTML = "화면을 그리다 문제가 생겼어요 😢<br/>" +
        "<b>앱을 완전히 껐다가 다시 열어</b> 주세요.<br/>" +
        `<span style="font-size:12px;opacity:.7">(${APP_VERSION} · ${escapeHtml(String((e && e.message) || e)).slice(0, 80)})</span>`;
      footNote.innerHTML = "🔒 <b>녹음은 안전해요</b> — 기기 안에 그대로 있어요";
    }
  }
  async function renderHomeInner() {
    const prog = await loadProgress();
    homeProg = prog;
    let any = false, ready = 0;
    gridEl.innerHTML = STORIES.map((s, i) => {
      const p = prog[s.id];
      if (p && (p.mom.size || p.dad.size || p.momOld || p.dadOld)) any = true;
      const kind = storyKind(p, s);
      if (kind) ready++;
      // 들려줄 수 있으면 "누구 목소리인지", 아니면 "어디까지 녹음했는지"를 작게 붙인다.
      let tag = "";
      if (kind) {
        const v = storyVoice(p);
        tag = `<span class="gvoice ${v}">🎤 ${VOICE_LABEL[v]}</span>`;
      } else {
        const c = p ? p[storyVoice(p)].size : 0;
        tag = `<span class="gtodo">🎙 ${c ? c + " / " + sceneCount(s) : "녹음 전"}</span>`;
      }
      return `<li class="gcard ${kind ? "" : "todo"}" data-idx="${i}" data-ready="${kind ? "1" : ""}" tabindex="0" role="button">` +
        `<span class="gcover" aria-hidden="true">${s.cover}</span>` +
        `<span class="gname">${escapeHtml(s.title)}</span>${tag}</li>`;
    }).join("");

    gridEl.querySelectorAll(".gcard").forEach((el) => {
      const open = () => {
        if (el.dataset.ready) openPlay(+el.dataset.idx, homeProg);
        else toast("아직 다 녹음하지 않았어요 🎙  아래 ‘녹음하기’에서 이어서 담아 주세요");
      };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });

    shuffleBtn.hidden = ready === 0;
    emptyNote.hidden = ready !== 0;
    if (!ready) emptyNote.innerHTML = "아직 담긴 목소리가 없어요.<br/>아래 <b>🎙 녹음하기</b>로 첫 이야기를 담아 주세요.";

    updateNameUI();
    updateFootNote(any);
    updateInstallBar();
  }
  async function showHome() {
    if (rec.recording) { toast("녹음을 먼저 멈춰 주세요"); return; }
    stopEverything();
    setScreen(homeEl);
    await renderHome();
  }

  /* ================= 녹음할 이야기 고르기 (부모용) =================
   * 아기 화면(홈)과 완전히 분리된 한 단계 안쪽 화면. 여기서만 녹음으로 들어간다. */
  async function showPick() {
    if (rec.recording) { toast("녹음을 먼저 멈춰 주세요"); return; }
    stopEverything();
    const prog = await loadProgress();
    pickListEl.innerHTML = STORIES.map((s, i) => {
      const p = prog[s.id] || emptySlot();
      const v = storyVoice(p), N = sceneCount(s), c = p[v].size;
      const has = c > 0 || p[v + "Old"];
      // 녹음이 있으면 누구 목소리인지 먼저 보여준다
      let pill = has ? `<span class="spill voice ${v}">🎤 ${VOICE_LABEL[v]}</span>` : "";
      if (c === 0 && storyKind(p, s) === "legacy") pill += `<span class="spill old">예전 녹음</span>`;
      else if (c >= N) pill += `<span class="spill full">✅ 다 녹음했어요</span>`;
      else if (c > 0) pill += `<span class="spill part">${c} / ${N} 녹음</span>`;
      else pill += `<span class="spill">아직 녹음 전</span>`;
      return `<li class="scard" data-idx="${i}" tabindex="0" role="button">` +
        `<span class="scover" aria-hidden="true">${s.cover}</span>` +
        `<span class="sinfo"><span class="sname">${escapeHtml(s.title)}</span>` +
        `<span class="spills">${pill}</span></span>` +
        `<span class="schev">❯</span></li>`;
    }).join("");
    pickListEl.querySelectorAll(".scard").forEach((el) => {
      const open = () => openRec(+el.dataset.idx, prog);
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
    setScreen(pickEl);
  }

  /* ================= 녹음 화면 (부모용) ================= */
  async function openRec(i, prog) {
    if (!getMyVoice()) { askMyVoice(() => openRec(i, prog)); return; }   // 처음 한 번만 묻는다
    stopEverything();
    rec.story = storyByIdx(i); rec.scene = 0;
    recTitleEl.textContent = rec.story.title;
    setScreen(recEl);
    await loadRecState(prog);
    paintVoiceTabs();
    // 이어서 녹음하기 편하게, 아직 녹음 안 한 첫 장면부터 보여준다
    const N = sceneCount(rec.story);
    for (let k = 0; k < N; k++) if (!rec.done.has(k)) { rec.scene = k; break; }
    renderRec(true);
  }
  async function loadRecState(prog) {
    const p = (prog && prog[rec.story.id]) || (await loadProgress())[rec.story.id];
    rec.voice = storyVoice(p);                       // 이 이야기가 쓰는 목소리 자리
    rec.done = new Set(p ? p[rec.voice] : []);
    rec.hasLegacy = !!(p && p[rec.voice + "Old"]);
    await loadHistMap();
  }
  /* 이 이야기·이 목소리의 '지난 녹음'이 장면마다 몇 개인지 미리 세어 둔다.
   * (버튼을 그릴 때마다 저장소를 뒤지지 않으려고 한 번에 읽는다) */
  async function loadHistMap() {
    rec.histMap = {};
    let keys = [];
    try { keys = await dbAllKeys(); } catch (e) { return; }
    const head = `${rec.story.id}:${STORE_VER}:${rec.voice}:`;
    for (const k of keys) {
      if (!isHistKey(k)) continue;
      const owner = histOwner(k);
      if (owner.indexOf(head) !== 0) continue;
      const idx = +owner.slice(head.length);
      if (!(idx >= 0)) continue;
      rec.histMap[idx] = (rec.histMap[idx] || 0) + 1;
    }
  }
  function paintRecScene(anim) {
    const sc = rec.story.scenes[rec.scene];
    recArtEl.textContent = sc.emoji;
    recTextEl.innerHTML = sc.lines.map((l) => `<span class="ln">${renderName(l)}</span>`).join("");
    if (anim) [recArtEl, recTextEl].forEach((el) => { el.classList.remove("scene-in"); void el.offsetWidth; el.classList.add("scene-in"); });
  }
  function renderRecTop() {
    const N = sceneCount(rec.story);
    if (rec.recording) {
      recProgEl.innerHTML = `<span class="recing"><span class="recdot"></span>녹음 중… 다 읽으면 <b>멈춤</b></span>`;
    } else {
      let dots = "";
      for (let i = 0; i < N; i++) dots += `<span class="pd ${rec.done.has(i) ? "done" : ""} ${i === rec.scene ? "now" : ""}"></span>`;
      recProgEl.innerHTML = `<span class="pdots">${dots}</span><span>${rec.done.size} / ${N} 녹음</span>`;
    }
    // 예전 통 녹음만 있는 경우 안내 (예전 녹음은 지우지 않고 그대로 둔다)
    const showLegacy = rec.hasLegacy && rec.done.size < N && !rec.recording;
    legacyNoteEl.hidden = !showLegacy;
    if (showLegacy) {
      legacyNoteEl.innerHTML = `예전에 <b>통으로</b> 녹음한 게 있어요. ` +
        `그대로 들을 수 있고, 장면마다 다시 녹음하면 그림이 같이 넘어가요.`;
    }
  }
  function renderRecBottom() {
    const N = sceneCount(rec.story);
    // 페이저는 녹음 중에도 유지(화살표만 비활성). 녹음 버튼은 항상 맨 아래 고정.
    let html = `<div class="pager">` +
      `<button class="pnav" id="bPrev" type="button" ${rec.scene === 0 || rec.recording ? "disabled" : ""} aria-label="이전 장면">❮</button>` +
      `<span class="ppos">${rec.scene + 1} / ${N} 장면</span>` +
      `<button class="pnav" id="bNext" type="button" ${rec.scene === N - 1 || rec.recording ? "disabled" : ""} aria-label="다음 장면">❯</button>` +
      `</div>`;
    if (rec.done.has(rec.scene) && !rec.recording) {
      html += `<button class="listen ${rec.previewOn ? "on" : ""}" id="bConfirm" type="button">${rec.previewOn ? "⏸ 멈추기" : "🔊 녹음 확인"}</button>`;
    }
    // 다시 녹음한 장면에만 나타난다 — 평소엔 화면이 복잡해지지 않게
    const hn = rec.histMap[rec.scene] || 0;
    if (hn && !rec.recording) {
      html += `<button class="listen" id="bHist" type="button">↩️ 지난 녹음 (${hn}개)</button>`;
    }
    html += rec.recording
      ? `<button class="main-btn" id="bStop" type="button">■ 멈춤</button>`
      : `<button class="main-btn" id="bRec" type="button">🔴 ${rec.done.has(rec.scene) ? "이 장면 다시 녹음" : "이 장면 녹음"}</button>`;
    recBottomEl.innerHTML = html;
    const bind = (id, fn) => { const b = $(id); if (b) b.addEventListener("click", fn); };
    bind("bPrev", () => goScene(rec.scene - 1));
    bind("bNext", () => goScene(rec.scene + 1));
    bind("bConfirm", togglePreview);
    bind("bHist", openHistory);
    bind("bRec", startRecording);
    bind("bStop", stopRecording);
  }
  function renderRec(anim) { paintRecScene(anim); renderRecTop(); renderRecBottom(); }
  function paintVoiceTabs() {
    document.querySelectorAll(".vtab").forEach((t) => t.classList.toggle("on", t.dataset.voice === rec.voice));
  }
  /* 누구 목소리인지 바꾸기. 이야기 하나는 한 사람이 읽는다는 원칙은 그대로고,
   * 여기서 고른 쪽에 녹음이 담긴다. 예전 녹음이 반대쪽에 있으면 그쪽 진행 상황이 보인다. */
  async function setVoice(v) {
    if (v === rec.voice || rec.recording) return;
    stopPreview();
    rec.voice = v; rec.scene = 0;
    paintVoiceTabs();
    const p = (await loadProgress())[rec.story.id];
    rec.done = new Set(p ? p[v] : []);
    rec.hasLegacy = !!(p && p[v + "Old"]);
    const N = sceneCount(rec.story);
    for (let k = 0; k < N; k++) if (!rec.done.has(k)) { rec.scene = k; break; }
    renderRec(true);
    toast(`${VOICE_LABEL[v]} 목소리로 녹음해요 🎤`);
  }

  // 장면 이동. 녹음 확인 중이었다면 옮긴 장면의 녹음을 바로 이어 들려준다(빠른 확인).
  function goScene(i) {
    if (rec.recording) return;
    const t = Math.max(0, Math.min(i, sceneCount(rec.story) - 1));
    if (t === rec.scene) return;
    const wasPreview = rec.previewOn;
    stopPreview(); rec.scene = t; renderRec(true);
    if (wasPreview && rec.done.has(rec.scene)) togglePreview();
  }

  /* ================= 녹음 ================= */
  async function startRecording() {
    stopPreview();
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast("이 브라우저는 녹음을 지원하지 않아요"); return; }
    /* 폰 브라우저는 마이크를 켤 때 기본으로 '통화용 처리'(에코 제거·소음 억제·자동 볼륨)를 건다.
     * 그게 목소리를 실시간으로 깎고 붙여서 지지직거리거나 물속 소리처럼 만든다 → 모두 끈다.
     * (대신 방 소음이 그대로 들어오므로 조용한 곳에서 녹음하는 게 좋다) */
    try {
      rec.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
    } catch (e) {
      try { rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }   // 위 설정을 못 받는 기기 대비
      catch (e2) { toast("마이크 사용을 허용해 주세요 🎤"); return; }
    }
    const mime = pickMime();
    const opts = { audioBitsPerSecond: 128000 };     // 음질 넉넉하게 (브라우저 기본값보다 2배쯤)
    if (mime) opts.mimeType = mime;
    try { rec.recorder = new MediaRecorder(rec.stream, opts); }
    catch (e) {
      try { rec.recorder = new MediaRecorder(rec.stream); }
      catch (e2) { releaseStream(); toast("이 기기에서는 녹음할 수 없어요"); return; }
    }
    rec.chunks = [];
    rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
    rec.recorder.onstop = onRecorderStop;
    rec.recorder.start(); rec.recording = true;
    renderRecTop(); renderRecBottom();
  }
  function stopRecording() { if (rec.recorder && rec.recorder.state !== "inactive") rec.recorder.stop(); }
  async function onRecorderStop() {
    const mime = (rec.recorder && rec.recorder.mimeType) || pickMime() || "audio/webm";
    const blob = new Blob(rec.chunks, { type: mime });
    releaseStream(); rec.recorder = null; rec.recording = false;
    if (!blob.size) { toast("녹음이 비어 있어요. 다시 해볼까요?"); renderRec(false); return; }
    const key = sceneKey(rec.story.id, rec.voice, rec.scene);
    try {
      await pushHistory(key);                        // 예전 녹음을 '지난 녹음'으로 옮겨 둔다 (안 지운다)
      await dbPut({ key, storyId: rec.story.id, voice: rec.voice, scene: rec.scene, blob, mime, createdAt: Date.now() });
      rec.done.add(rec.scene); track("record_save");
      await loadHistMap();
    } catch (e) { toast("저장에 실패했어요 (저장 공간을 확인해 주세요)"); renderRec(false); return; }
    const N = sceneCount(rec.story);
    if (rec.done.size >= N) { toast("이 이야기를 다 녹음했어요 🎉  백업도 잊지 마세요!"); renderRec(true); return; }
    /* 다음 장면으로 — 반드시 '순서대로' 넘어간다.
     * 예전엔 '아직 안 한 장면'으로 건너뛰었는데, 1번을 다시 녹음하면 6번으로 튀어서
     * 2·3번을 이어서 다시 녹음할 수가 없었다. 처음부터 다시 담고 싶을 때 불편했다. */
    if (rec.scene < N - 1) rec.scene++;
    renderRec(true);
  }
  function releaseStream() { if (rec.stream) { rec.stream.getTracks().forEach((t) => t.stop()); rec.stream = null; } }

  /* ================= 녹음 확인(미리듣기) ================= */
  async function togglePreview() {
    if (rec.previewOn) { stopPreview(); renderRecBottom(); return; }
    const clip = await dbGet(sceneKey(rec.story.id, rec.voice, rec.scene));
    if (!clip) { toast("이 장면 녹음이 없어요"); return; }
    stopPreview();
    const url = URL.createObjectURL(clip.blob);
    const a = new Audio(url);
    a.addEventListener("ended", () => { stopPreview(); renderRecBottom(); });
    a.addEventListener("error", () => { stopPreview(); renderRecBottom(); toast("재생할 수 없어요"); });
    rec.preview = { audio: a, url }; rec.previewOn = true; renderRecBottom();
    a.play().catch(() => { stopPreview(); renderRecBottom(); toast("재생할 수 없어요"); });
  }
  function stopPreview() {
    if (rec.preview) {
      try { rec.preview.audio.pause(); } catch (e) {}
      URL.revokeObjectURL(rec.preview.url); rec.preview = null;
    }
    rec.previewOn = false;
  }

  /* ===== ↩️ 지난 녹음 고르기 =====
   * 다시 녹음했는데 예전 게 더 좋았을 때 되돌리는 창.
   * 고르면 '맞바꾸기'라서, 지금 쓰던 것도 이력으로 남아 언제든 다시 되돌릴 수 있다. */
  let histAudio = null;
  function stopHistAudio() {
    if (histAudio) { try { histAudio.pause(); } catch (e) {} if (histAudio.src) URL.revokeObjectURL(histAudio.src); histAudio = null; }
  }
  async function openHistory() {
    stopPreview();
    const key = sceneKey(rec.story.id, rec.voice, rec.scene);
    const hks = await histKeysOf(key);
    if (!hks.length) { toast("지난 녹음이 없어요"); return; }
    let cur = null;
    try { cur = await dbGet(key); } catch (e) {}
    const row = (label, k, isNow) =>
      `<li class="${isNow ? "now" : ""}">` +
      `<span class="when">${isNow ? "<b>지금 쓰는 녹음</b> · " : ""}${label}</span>` +
      `<button class="hb" type="button" data-play="${escapeHtml(k)}">▶</button>` +
      (isNow ? "" : `<button class="hb pick" type="button" data-use="${escapeHtml(k)}">이걸로</button>`) +
      `</li>`;
    openModal(`
      <div class="modal-body">
        <h2>지난 녹음 ↩️</h2>
        <p><b>${rec.scene + 1}번째 장면</b>이에요. 들어보고 마음에 드는 걸 고르세요.</p>
        <ul class="hist">
          ${row(agoText(cur && cur.createdAt), key, true)}
          ${hks.map((k) => row(agoText(histTime(k)), k, false)).join("")}
        </ul>
        <p class="hint">고르면 <b>맞바꿔요</b> — 지금 쓰던 녹음도 지난 녹음으로 남아서 언제든 되돌릴 수 있어요.
        장면마다 <b>최근 ${HISTORY_KEEP}개</b>까지 보관해요.</p>
      </div>`);
    modalBody.querySelectorAll("[data-play]").forEach((b) => b.addEventListener("click", async () => {
      stopHistAudio();
      let r = null;
      try { r = await dbGet(b.dataset.play); } catch (e) {}
      if (!r || !r.blob) { toast("녹음을 불러오지 못했어요"); return; }
      histAudio = new Audio(URL.createObjectURL(r.blob));
      histAudio.addEventListener("ended", stopHistAudio);
      histAudio.play().catch(() => {});
    }));
    modalBody.querySelectorAll("[data-use]").forEach((b) => b.addEventListener("click", async () => {
      stopHistAudio();
      const hk = b.dataset.use;
      let pick = null;
      try { pick = await dbGet(hk); } catch (e) {}
      if (!pick || !pick.blob) { toast("녹음을 불러오지 못했어요"); return; }
      try {
        await pushHistory(key);                                   // 지금 쓰던 걸 이력으로
        await dbPut({ key, storyId: rec.story.id, voice: rec.voice, scene: rec.scene,
          blob: pick.blob, mime: pick.mime, createdAt: Date.now() });
        await dbDel(hk);                                          // 고른 것은 이력에서 뺀다
        await loadHistMap();
      } catch (e) { toast("바꾸지 못했어요"); return; }
      closeModal(); renderRec(false);
      toast("지난 녹음으로 되돌렸어요 ↩️"); track("history_restore");
    }));
  }

  /* ================= 들려주기 (아기용) =================
   * 장면 클립을 순서대로 자동 재생하며 그림도 함께 넘어간다.
   * 예전(통) 녹음뿐인 이야기는 그 파일을 통째로 들려준다(그림은 표지 하나).
   * 화면 탭 = 멈춤 / 이어보기. 여기엔 녹음으로 가는 길이 없다. */
  // 들려줄 수 있는 이야기(전 장면 녹음 완료 또는 예전 녹음) 번호만 모은다.
  function playableIdxs(prog) {
    const out = [];
    STORIES.forEach((s, i) => { if (storyKind(prog[s.id], s)) out.push(i); });
    return out;
  }
  // Fisher-Yates 섞기 (원본은 그대로, 섞인 새 배열 반환)
  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  /* 이어 들려줄 '차례표'를 만든다. 이야기 단위로 섞으므로 한 바퀴 돌기 전엔 같은 이야기가 다시 안 나온다.
   * firstIdx 를 주면 그 이야기를 맨 앞으로 (홈에서 직접 고른 경우). */
  function buildPlaylist(prog, firstIdx) {
    let list = shuffled(playableIdxs(prog));
    if (firstIdx >= 0) { list = list.filter((n) => n !== firstIdx); list.unshift(firstIdx); }
    pb.list = list; pb.listIdx = 0;
  }
  function openPlay(i, prog) {
    stopEverything();
    pb.prog = prog || {};
    buildPlaylist(pb.prog, i);
    beginStory(i);
  }
  // 🌙 쭉 들려주기 — 아무거나 골라서 계속 이어 재생
  function openShuffle() {
    const list = playableIdxs(homeProg);
    if (!list.length) { toast("아직 녹음된 이야기가 없어요 🎙"); return; }
    stopEverything();
    pb.prog = homeProg;
    buildPlaylist(pb.prog, -1);
    track("play_shuffle");
    beginStory(pb.list[0]);
  }
  function beginStory(i) {
    clearNextTimer();
    pb.story = storyByIdx(i);
    const p = pb.prog[pb.story.id];
    pb.voice = storyVoice(p);
    pb.mode = storyKind(p, pb.story) || "scenes";
    pb.scene = 0;
    setScreen(playEl);
    hidePauseOv();
    playCurrent(); track("play");
  }
  // 한 편이 끝나면 차례표의 다음 편으로. 다 돌면 다시 섞는다(같은 이야기가 연달아 나오지 않게).
  function nextStory() {
    clearNextTimer();
    if (!pb.list.length) { showHome(); return; }
    pb.listIdx++;
    if (pb.listIdx >= pb.list.length) {
      const last = pb.list[pb.list.length - 1];
      pb.list = shuffled(pb.list);
      if (pb.list.length > 1 && pb.list[0] === last) pb.list.push(pb.list.shift());
      pb.listIdx = 0;
    }
    beginStory(pb.list[pb.listIdx]);
  }
  function clearNextTimer() { if (pb.nextTimer) { clearTimeout(pb.nextTimer); pb.nextTimer = null; } }
  function paintPlayScene(anim) {
    if (pb.mode === "legacy") {
      playArtEl.textContent = pb.story.cover;
      playTextEl.innerHTML = `<span class="ln">${escapeHtml(pb.story.title)}</span>` +
        `<span class="ln" style="font-size:15px;opacity:.7">예전 녹음</span>`;
    } else {
      const sc = pb.story.scenes[pb.scene];
      playArtEl.textContent = sc.emoji;
      playTextEl.innerHTML = sc.lines.map((l) => `<span class="ln">${renderName(l)}</span>`).join("");
    }
    if (anim) [playArtEl, playTextEl].forEach((el) => { el.classList.remove("scene-in"); void el.offsetWidth; el.classList.add("scene-in"); });
  }
  /* ===== 재생기는 하나만 쓴다 (화면 꺼도 이어지게) =====
   * 장면마다 `new Audio()` 를 새로 만들면, 아이폰이 "사람이 안 눌렀는데 새로 트는 것"으로 보고
   * 화면이 꺼진 동안 다음 장면 재생을 막아 버린다 → 한 장면만 나오고 멈춘다.
   * 재생기 하나를 계속 쓰고 내용(src)만 갈아끼우면 "아까 사람이 튼 그것"으로 인정돼 이어진다.
   * ⚠️ 다시 `new Audio()` 방식으로 되돌리지 말 것. */
  let audioEl = null;
  function getAudio() {
    if (audioEl) return audioEl;
    const a = new Audio();
    a.preload = "auto";
    a.setAttribute("playsinline", "");
    a.addEventListener("ended", () => { if (pb.state === "playing") pbAdvance(); });
    a.addEventListener("error", () => { if (pb.state === "playing") pbAdvance(); });
    audioEl = a;
    return a;
  }

  /* 잠금화면·제어센터에 "별밤책 · 커다란 순무" 와 ⏯️ 버튼을 띄운다.
   * 음악 앱처럼 보여야 폰이 '진짜 재생 중'으로 대우해 줘서, 화면을 꺼도 소리가 이어진다. */
  function setMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    try {
      if (typeof MediaMetadata !== "undefined" && pb.story) {
        const name = getBabyName();
        ms.metadata = new MediaMetadata({
          title: pb.story.title,
          artist: name ? josaUi(name) + " 별밤책" : "별밤책 🌙",
          album: (pb.scene + 1) + " / " + sceneCount(pb.story) + " 장면",
          artwork: [
            { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          ],
        });
      }
      ms.playbackState = pb.state === "playing" ? "playing" : "paused";
      const on = (k, fn) => { try { ms.setActionHandler(k, fn); } catch (e) {} };
      on("play", () => { if (pb.state !== "playing") pbResume(); });
      on("pause", () => { if (pb.state === "playing") pbPause(); });
      on("nexttrack", () => nextStory());                                   // 다른 이야기로
      on("previoustrack", () => { if (pb.story) { pb.scene = 0; playCurrent(); } });  // 이 이야기 처음부터
      on("stop", () => showHome());
    } catch (e) {}
  }

  async function playCurrent() {
    hidePauseOv(); paintPlayScene(true); pb.state = "playing";
    let clip = null;
    const key = pb.mode === "legacy" ? legacyKey(pb.story.id, pb.voice) : sceneKey(pb.story.id, pb.voice, pb.scene);
    try { clip = await dbGet(key); } catch (e) {}
    if (pb.state !== "playing") return;             // 불러오는 사이에 멈췄으면 중단
    if (!clip) { pbAdvance(); return; }             // 혹시 빈 장면이면 건너뜀
    const a = getAudio();
    try { a.pause(); } catch (e) {}
    const old = pb.url;
    pb.url = URL.createObjectURL(clip.blob);
    a.src = pb.url;
    pb.audio = a;
    if (old) URL.revokeObjectURL(old);            // 바꿔 끼운 뒤에 예전 것을 버린다
    a.play().catch(() => { /* 자동재생이 막히면 조용히 둔다 (화면 탭으로 이어감) */ });
    setMediaSession();
  }
  function pbAdvance() {
    if (pb.state !== "playing") return;
    if (pb.mode === "scenes" && pb.scene < sceneCount(pb.story) - 1) { pb.scene++; playCurrent(); }
    else pbEnd();
  }
  function pbPause() {
    clearNextTimer();
    if (audioEl) { try { audioEl.pause(); } catch (e) {} }
    pb.state = "paused"; showPauseOv("paused"); setMediaSession();
  }
  function pbResume() {
    hidePauseOv(); pb.state = "playing";
    if (pb.audio && pb.url) pb.audio.play().catch(() => {}); else playCurrent();
    setMediaSession();
  }
  // 한 편이 끝나면 잠깐 여운을 두고 저절로 다른 이야기로 이어진다.
  function pbEnd() {
    stopPlayAudio(); pb.state = "ended"; showPauseOv("ended");
    clearNextTimer();
    pb.nextTimer = setTimeout(nextStory, 2600);
  }
  /* 소리만 멈춘다. 재생기(audioEl)는 버리지 않고 계속 갖고 있는다 —
   * 버렸다가 새로 만들면 화면 꺼진 동안 다시 못 틀게 된다. */
  function stopPlayAudio() {
    if (audioEl) { try { audioEl.pause(); } catch (e) {} }
    if (pb.url) { URL.revokeObjectURL(pb.url); pb.url = null; }
    pb.audio = null;
    if ("mediaSession" in navigator) { try { navigator.mediaSession.playbackState = "paused"; } catch (e) {} }
  }
  function stopPlayback() { clearNextTimer(); stopPlayAudio(); pb.state = "idle"; hidePauseOv(); }

  function hidePauseOv() { pauseOvEl.hidden = true; pauseOvEl.innerHTML = ""; }
  function showPauseOv(kind) {
    let html;
    if (kind === "paused") {
      html = `<div class="po-moon">🌙</div><div class="po-t">잠깐 멈췄어요</div>` +
        `<div class="po-s">화면을 다시 누르면 이어서 들려줘요</div>`;
      if (pb.mode === "legacy") html += `<div class="po-s">예전 녹음이에요. 장면마다 다시 녹음하면 그림이 함께 넘어가요.</div>`;
      html += `<div class="po-btns"><button class="po-b" type="button" data-a="next">🎲 다른 이야기</button></div>`;
    } else {
      html = `<div class="po-moon">💤</div><div class="po-t">다 읽었어요</div>` +
        `<div class="po-s">잠시 뒤 다른 이야기가 이어져요…</div>` +
        `<div class="po-btns"><button class="po-b" type="button" data-a="next">🎲 지금 바로</button>` +
        `<button class="po-b" type="button" data-a="stop">■ 그만 들을래요</button></div>`;
    }
    pauseOvEl.innerHTML = html; pauseOvEl.hidden = false;
    pauseOvEl.querySelectorAll(".po-b").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.dataset.a === "next") nextStory(); else { clearNextTimer(); showHome(); }
    }));
  }
  // 무대 탭: 재생 중이면 멈춤. 멈춤 화면의 배경 탭 = 이어보기.
  playStageEl.addEventListener("click", () => { if (pb.state === "playing") pbPause(); });
  pauseOvEl.addEventListener("click", (e) => { e.stopPropagation(); if (pb.state === "paused") pbResume(); });

  /* ================= 전체 백업 / 복원 =================
   * 원리: 저장된 녹음 전부(장면 클립 + 예전 통 녹음) → base64로 .txt 하나.
   *   복원은 '합치기' — 같은 열쇠는 덮어쓰고, 없던 건 추가한다.
   *   → 엄마·아빠가 서로 백업 파일을 주고받아 복원하면 두 목소리가 한 폰에 합쳐진다.
   * 파일은 모달 열 때 미리 만든다: 아이폰은 버튼 누른 '직후'에만 공유창을 허용해서,
   *   공유 직전에 await가 끼면 창이 안 뜬다. (카톡이 .json 을 거부해서 .txt 로 만든다) */
  let backupReady = null;     // { file, blob, count } | { empty:true } | null
  let backupBuilding = false;
  /* 지난 녹음까지 담을지. 기본은 끈다 —
   * 다 담으면 파일이 몇 배로 커져서, 아이폰이 백업 파일을 만들다 버거워질 수 있다.
   * 폰을 바꾸기 전처럼 통째로 옮겨야 할 때만 켠다. */
  let backupWithHistory = false;
  async function buildBackup() {
    backupReady = null; backupBuilding = true; updateBackupHint();
    try {
      const all = await dbAll();
      if (!all.length) { backupReady = { empty: true, count: 0 }; return; }
      const clips = [];
      for (const r of all) {
        if (!r || !r.key || !r.blob) continue;
        if (!backupWithHistory && isHistKey(r.key)) continue;      // 지난 녹음은 기본으로 빼둔다
        clips.push({ key: r.key, mime: r.mime || r.blob.type || "audio/webm", createdAt: r.createdAt || Date.now(), data: await blobToDataURL(r.blob) });
      }
      if (!clips.length) { backupReady = { empty: true, count: 0 }; return; }
      const payload = { app: "별밤책", kind: "scene-clips", version: 3, exportedAt: Date.now(), clips };
      const blob = new Blob([JSON.stringify(payload)], { type: "text/plain" });
      const file = new File([blob], "별밤책-백업.txt", { type: "text/plain" });
      backupReady = { file, blob, count: clips.length, bytes: blob.size };
    } catch (e) { backupReady = null; }
    finally { backupBuilding = false; updateBackupHint(); }
  }
  function updateBackupHint() {
    const h = $("backupHint"); if (!h) return;
    if (backupBuilding || !backupReady) { h.textContent = "백업 파일을 준비하고 있어요…"; return; }
    if (backupReady.empty) { h.textContent = "아직 백업할 녹음이 없어요."; return; }
    if (isInAppBrowser()) {
      h.innerHTML = "⚠️ <b>카톡·인스타 안</b>에서는 백업을 보낼 수 없어요. <b>사파리·크롬</b>으로 열어주세요.";
      return;
    }
    const mb = backupReady.bytes ? " · 약 " + Math.max(1, Math.round(backupReady.bytes / 1048576)) + "MB" : "";
    h.innerHTML = "준비 완료 — <b>" + backupReady.count + "개</b> 녹음을 보낼 수 있어요" + mb + ".";
  }
  // 카톡/메일/드라이브 등으로 보내기. 공유창을 버튼 클릭 '즉시' 띄운다(중간 await 없음).
  async function sendBackup() {
    if (backupBuilding || !backupReady) { toast("백업을 준비하고 있어요. 잠깐 뒤 다시 눌러주세요"); return; }
    if (backupReady.empty) { toast("백업할 녹음이 없어요"); return; }
    const { file, blob, count } = backupReady;
    /* ⚠️ 공유할 땐 **파일만** 보낸다. title·text 를 같이 실으면
     * 카카오톡 같은 앱이 **글만 받고 파일을 버리는** 일이 있다.
     * (실제로 "공유는 눌렀는데 파일이 첨부가 안 됐다"는 제보를 받아 고쳤다 — v33)
     * 절대 files 와 text 를 함께 보내도록 되돌리지 말 것. */
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file] });
        markBackedUp();
        toast(count + "개 백업을 보냈어요 🛟  (카톡 ‘나에게’ 추천)"); track("backup"); return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;   // 사용자가 취소
    }
    backupFallback(blob);
  }

  /* 공유창이 안 뜨거나 파일 공유를 못 하는 환경.
   * 예전엔 파일만 슬쩍 저장하고 작은 안내만 띄워서, 사용자는 "아무 일도 안 일어났다"고 느꼈다.
   * 무슨 일이 있었는지와 다음에 뭘 하면 되는지를 분명히 보여준다. */
  function backupFallback(blob) {
    const iab = isInAppBrowser();
    if (!iab) downloadBlob(blob, "별밤책-백업.txt");   // 인앱 브라우저는 저장도 잘 안 된다
    markBackedUp(); track("backup_fallback");
    openModal(`
      <div class="modal-body">
        <h2>${iab ? "여기서는 백업이 안 돼요 🙏" : "백업 파일을 저장했어요 🛟"}</h2>
        ${iab
          ? `<p>지금 <b>카카오톡·인스타 같은 앱 안</b>에서 열려 있어요.
             여기서는 파일을 보낼 수가 없어요.</p>
             <p><b>이렇게 해주세요:</b></p>
             <ol class="steps-big">
               <li><span>화면 <b>오른쪽 메뉴(⋯ 또는 나침반)</b> 를 누르세요</span></li>
               <li><span><b>“다른 브라우저로 열기 / Safari로 열기”</b> 를 고르세요</span></li>
               <li><span>거기서 <b>⚙️ 더보기 → 백업</b> 을 다시 눌러주세요</span></li>
             </ol>`
          : `<p>이 브라우저는 카톡으로 <b>바로 보내기</b>를 지원하지 않아서,
             <b>별밤책-백업.txt</b> 파일로 저장했어요.</p>
             <p><b>카톡으로 보내려면:</b></p>
             <ol class="steps-big">
               <li><span>카톡에서 <b>‘나에게’ 채팅방</b>을 여세요</span></li>
               <li><span><b>+ 버튼 → 파일</b> 을 고르세요</span></li>
               <li><span>방금 저장한 <b>별밤책-백업.txt</b> 를 고르면 끝!</span></li>
             </ol>
             <p class="hint">📁 파일은 <b>“파일” 앱</b>(안드로이드는 <b>다운로드</b> 폴더)에 있어요.</p>`}
        <button class="modal-btn gold" id="bfOk" type="button">알겠어요</button>
      </div>`);
    const ok = $("bfOk"); if (ok) ok.addEventListener("click", closeModal);
  }
  /* ===== 복원 = '합치기' =====
   * 녹음이 사라지는 게 가장 치명적이므로 세 겹으로 지킨다.
   *   ① 내가 갖고 있는데 파일에 없는 녹음은 절대 건드리지 않는다(삭제 없음).
   *   ② 같은 자리에 둘 다 있으면 **더 나중에 녹음한 쪽**만 남긴다.
   *      (예전엔 무조건 덮어써서, 어제 백업을 오늘 복원하면 오늘 녹음이 되돌아갔다)
   *   ③ 넣기 전에 무엇이 늘고/바뀌고/그대로인지 보여주고 확인받는다.
   * 엄마 칸과 아빠 칸은 자리가 다르므로, 서로 백업을 주고받으면 자연히 나란히 합쳐진다. */
  let pendingRestore = null;

  function ymd(ms) {
    if (!ms) return "";
    try {
      const d = new Date(ms);
      return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
    } catch (e) { return ""; }
  }

  /* 🎁 공유하기. 폰 공유창을 띄우고, 안 되면 주소를 복사해 준다.
   * 아이폰은 '누르자마자' 공유창이 떠야 해서 앞에 await 를 두지 않는다. */
  function shareApp() {
    /* ⚠️ 글(text)과 주소(url)를 **둘 다** 실어 보낸다.
     *   - v33 에서 글만 보내게 했더니 **안드로이드 카톡에 빈 메시지**가 갔다.
     *     안드로이드 카톡은 주소가 없으면 아무것도 못 붙이는 것으로 보인다.
     *   - 반대로 글 안에 주소를 또 넣으면 주소가 두 번 나온다 → 글에서는 주소를 뺐다(SHARE_BODY).
     *   브라우저가 "글 + 주소"로 합쳐 주므로 받는 쪽에는 한 덩어리로 보인다.
     * 🚨 title 은 넣지 않는다 — 앱에 따라 제목만 가져가고 본문을 버린다.
     * (파일을 보낼 때는 반대로 파일만 보낸다 — sendBackup 참고) */
    if (navigator.share) {
      navigator.share({ text: SHARE_BODY, url: SHARE_URL })
        .then(() => { toast("알려줬어요 🔗 고마워요!"); track("share"); })
        .catch((e) => { if (!e || e.name !== "AbortError") copyShare(); });   // 취소는 조용히
      return;
    }
    copyShare();
  }
  function copyShare() {
    const done = () => { toast("주소를 복사했어요 📋  카톡에 붙여 넣어 주세요"); track("share_copy"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(SHARE_TEXT).then(done, showShareText);
    } else showShareText();
  }
  // 복사도 안 되는 환경: 글을 띄워서 직접 골라 복사하게
  function showShareText() {
    openModal(`
      <div class="modal-body">
        <h2>공유하기 🎁</h2>
        <p>아래 글을 <b>꾹 눌러 복사</b>해서 카톡에 붙여 넣어 주세요.</p>
        <textarea class="text-area" id="shareBox" readonly style="min-height:190px">${escapeHtml(SHARE_TEXT)}</textarea>
      </div>`);
    const box = $("shareBox");
    if (box) { box.focus(); box.select(); }
    track("share_manual");
  }

  async function restoreFromFile(file) {
    if (!file) return;
    let payload = null;
    try { payload = JSON.parse(await file.text()); }
    catch (e) { toast("백업 파일을 읽지 못했어요 (파일을 확인해 주세요)"); return; }
    // 지금 방식(clips) + 예전 방식(recordings) 백업 파일 둘 다 받는다
    const list = payload && (Array.isArray(payload.clips) ? payload.clips
      : (Array.isArray(payload.recordings) ? payload.recordings : null));
    if (!list || !list.length) { toast("별밤책 백업 파일이 아니에요"); return; }

    // 지금 내 녹음과 견줘 본다
    const mine = {};
    try { (await dbAll()).forEach((r) => { if (r && r.key) mine[r.key] = r.createdAt || 0; }); } catch (e) {}
    const add = [], newer = [], keep = [];
    for (const it of list) {
      if (!it || !it.key || !it.data) continue;
      if (!(it.key in mine)) add.push(it);
      else if ((it.createdAt || 0) > mine[it.key]) newer.push(it);
      else keep.push(it);
    }
    pendingRestore = add.concat(newer);

    const when = ymd(payload && payload.exportedAt);
    const row = (icon, text, n) =>
      `<li class="${n ? "" : "zero"}"><span>${icon} ${text}</span><span class="n">${n}개</span></li>`;
    openModal(`
      <div class="modal-body">
        <h2>백업 합치기 📥</h2>
        <p>${when ? `<b>${when}</b>에 만든 백업이에요. ` : ""}이렇게 합쳐질 거예요.</p>
        <ul class="plan">
          ${row("➕", "새로 들어와요", add.length)}
          ${row("🔁", "더 새로 녹음한 걸로 바뀌어요", newer.length)}
          ${row("✅", "내 것이 최신이라 그대로 둬요", keep.length)}
        </ul>
        <p class="hint">🔒 지금 갖고 있는 녹음은 <b>지워지지 않아요.</b>
        같은 자리에 둘 다 있으면 <b>더 나중에 녹음한 쪽</b>만 남겨요.</p>
        <button class="modal-btn gold" id="planGo" type="button">
          ${pendingRestore.length ? `${pendingRestore.length}개 합치기` : "합칠 게 없어요"}
        </button>
        <button class="modal-btn ghost" id="planNo" type="button">취소</button>
      </div>`);
    $("planNo").addEventListener("click", () => { pendingRestore = null; closeModal(); });
    $("planGo").addEventListener("click", applyRestore);
  }

  async function applyRestore() {
    const list = pendingRestore || [];
    pendingRestore = null;
    const btn = $("planGo");
    if (btn) { btn.disabled = true; btn.textContent = "합치는 중…"; }
    let n = 0, fail = 0;
    for (const it of list) {
      try {
        const blob = await (await fetch(it.data)).blob();
        await dbPut({ key: it.key, blob, mime: it.mime || blob.type, createdAt: it.createdAt || Date.now() });
        n++;
      } catch (e) { fail++; }
    }
    closeModal();
    toast(n ? `${n}개 녹음을 합쳤어요 🛟${fail ? ` (${fail}개 실패)` : ""}` : "이미 다 갖고 있어요 👍");
    track("restore");
    if (homeEl.classList.contains("active")) await renderHome();
    else if (pickEl.classList.contains("active")) await showPick();
    else if (recEl.classList.contains("active")) { await loadRecState(null); renderRec(false); }
  }

  /* ================= 시범 페이지(story-demo) 녹음 가져오기 =================
   * 시범 페이지는 저장 창고가 따로였다(`voicebook-demo`). 열쇠 모양은 지금과 같으므로,
   * 처음 한 번만 통째로 옮겨온다(이미 있는 건 건드리지 않음). 시범 쪽 원본은 그대로 둔다. */
  function readDemoClips() {
    return new Promise((resolve) => {
      let existed = true;
      let req;
      try { req = indexedDB.open("voicebook-demo"); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => { existed = false; };   // 없던 저장소 → 방금 새로 만들어진 것
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const d = req.result;
        if (!existed || !d.objectStoreNames.contains("clips")) {
          d.close();
          if (!existed) { try { indexedDB.deleteDatabase("voicebook-demo"); } catch (e) {} }
          resolve(null); return;
        }
        const r = d.transaction("clips").objectStore("clips").getAll();
        r.onsuccess = () => { resolve(r.result || []); d.close(); };
        r.onerror = () => { resolve(null); d.close(); };
      };
    });
  }
  async function importDemoClipsOnce() {
    try { if (localStorage.getItem("demoImported") === "1") return; } catch (e) {}
    let clips = null;
    try { clips = await readDemoClips(); } catch (e) { return; }
    if (!clips) return;
    let n = 0;
    for (const r of clips) {
      if (!r || !r.key || !r.blob) continue;
      if (String(r.key).split(":").length !== 4) continue;      // 장면 클립만
      try { if (await dbGet(r.key)) continue; } catch (e) { continue; }
      try { await dbPut({ key: r.key, blob: r.blob, mime: r.mime || r.blob.type, createdAt: Date.now() }); n++; } catch (e) {}
    }
    try { localStorage.setItem("demoImported", "1"); } catch (e) {}
    if (n) { toast(n + "개 녹음을 시범 화면에서 가져왔어요 🌙"); await renderHome(); }
  }

  /* ================= 모달 (이름 · 더보기) ================= */
  function openModal(html) { modalBody.innerHTML = html; modalEl.hidden = false; }
  function closeModal() { stopHistAudio(); modalEl.hidden = true; modalBody.innerHTML = ""; }

  /* "이 폰은 누구 폰인가요?" — 녹음하러 처음 들어갈 때 한 번만 묻는다.
   * 더보기에서 언제든 바꿀 수 있다. */
  function askMyVoice(after) {
    const cur = getMyVoice();
    openModal(`
      <div class="modal-body">
        <h2>이 폰은 누구 폰인가요? 🎤</h2>
        <p>여기서 녹음하는 목소리를 <b>이 사람 것</b>으로 담아 둘게요.
        나중에 엄마·아빠가 <b>백업 파일을 주고받아도</b> 서로 덮어쓰지 않고 <b>나란히 합쳐져요.</b></p>
        <div class="who">
          <button class="who-b ${cur === "mom" ? "on" : ""}" type="button" data-v="mom">👩 엄마 폰</button>
          <button class="who-b ${cur === "dad" ? "on" : ""}" type="button" data-v="dad">👨 아빠 폰</button>
        </div>
        <p class="hint">※ 나중에 <b>⚙️ 더보기</b>에서 바꿀 수 있어요. 이야기마다 따로 고르는 것도 그대로 돼요.</p>
      </div>`);
    modalBody.querySelectorAll(".who-b").forEach((b) => b.addEventListener("click", () => {
      setMyVoice(b.dataset.v);
      closeModal();
      toast(`이 폰은 ${VOICE_LABEL[b.dataset.v]} 폰이에요 🎤`);
      if (typeof after === "function") after();
      else if (homeEl.classList.contains("active")) renderHome();
    }));
  }

  function openName() {
    const name = getBabyName();
    openModal(`
      <div class="modal-body">
        <h2>아기 이름 정하기 👶</h2>
        <p>이름을 넣으면 대본 속 <b>(아기 이름)</b> 자리가 우리 아기 이름으로 바뀌어요.
        예) "잘 자렴, <span class="nm">(지우)야</span>"</p>
        <label class="field-label" for="nameInput">아기 이름</label>
        <input class="text-input" id="nameInput" type="text" maxlength="12" placeholder="예: 지우" value="${escapeHtml(name)}" />
        <p class="hint">※ 이름을 바꾼 뒤엔, 이미 한 녹음은 예전 이름으로 들려요. 새 이름으로 다시 녹음하는 걸 권해요.</p>
        <button class="modal-btn gold" id="nameSave" type="button">저장</button>
        ${name ? '<button class="modal-btn ghost" id="nameClear" type="button">이름 지우기</button>' : ""}
      </div>`);
    const input = $("nameInput"); input.focus();
    $("nameSave").addEventListener("click", () => {
      const v = input.value.trim();
      try { if (v) localStorage.setItem("babyName", v); else localStorage.removeItem("babyName"); } catch (e) {}
      updateNameUI(); refreshNameInText();
      toast(v ? `"${v}" 이름을 넣었어요 💛` : "이름을 비웠어요"); track("set_name"); closeModal();
    });
    if (name) $("nameClear").addEventListener("click", () => {
      try { localStorage.removeItem("babyName"); } catch (e) {}
      updateNameUI(); refreshNameInText(); toast("이름을 지웠어요"); closeModal();
    });
  }

  /* ---------- 더보기: 백업 · 사용법 · 의견을 한 창에 (쭉 스크롤) ---------- */
  function openMore() {
    openModal(`
      <div class="modal-body">
        <h2>더보기 ⚙️</h2>

        <h3 class="more-sec">🎤 이 폰은 누구 폰</h3>
        <p>여기서 새로 녹음하면 <b>${getMyVoice() ? VOICE_LABEL[getMyVoice()] : "아직 안 정함"}</b> 목소리로 담겨요.
        엄마·아빠가 각자 폰에 정해 두면, 백업을 주고받아도 <b>서로 덮어쓰지 않아요.</b></p>
        <div class="who">
          <button class="who-b ${getMyVoice() === "mom" ? "on" : ""}" type="button" data-mv="mom">👩 엄마 폰</button>
          <button class="who-b ${getMyVoice() === "dad" ? "on" : ""}" type="button" data-mv="dad">👨 아빠 폰</button>
        </div>

        <hr class="more-hr" />

        <h3 class="more-sec">🛟 녹음 백업 · 복원</h3>
        <p>녹음은 이 기기 안에만 있어요. <b>카카오톡 ‘나에게 보내기’</b>로 백업해 두면,
        폰을 바꾸거나 실수로 지워져도 카톡에서 다시 <b>복원</b>할 수 있어요.</p>
        <button class="modal-btn gold" id="doBackup" type="button">💬 카카오톡으로 백업 보내기</button>
        <label class="check"><input type="checkbox" id="bkHist" ${backupWithHistory ? "checked" : ""} />
        <span>지난 녹음까지 함께 담기 <b>(파일이 커져요)</b></span></label>
        <p class="hint" id="backupHint">백업 파일을 준비하고 있어요…</p>
        <ol class="steps">
          <li>위 버튼을 누르면 <b>공유창</b>이 떠요</li>
          <li><b>카카오톡</b> 선택 → <b>나에게 보내기</b>(내 채팅방)에 저장</li>
        </ol>
        <p class="hint">💡 <b>엄마·아빠 팁:</b> 서로 백업 파일을 주고받아 복원하면 <b>상대가 녹음한 이야기까지 한 폰에서</b> 들을 수 있어요.
        복원은 <b>합치기</b>라서 내 녹음은 지워지지 않고, <b>더 새로 녹음한 쪽이 남아요.</b></p>

        <h3>📥 복원하기 (백업에서 되살리기)</h3>
        <ol class="steps">
          <li>카톡 <b>나에게</b>에서 <b>별밤책-백업.txt</b>를 눌러 → <b>공유 → “파일에 저장”</b></li>
          <li>아래 버튼을 누르고, 방금 저장한 <b>별밤책-백업.txt</b>를 고르기</li>
        </ol>
        <button class="modal-btn ghost" id="doRestore" type="button">📥 백업 파일에서 복원</button>
        <p class="hint">※ <b>카톡·인스타 안</b>에서 열었다면 백업이 안 될 수 있어요. <b>사파리·크롬</b>으로 열어주세요.
        백업은 사진첩이 아니라 <b>파일</b>로 저장돼요.</p>

        <hr class="more-hr" />

        <h3 class="more-sec">❔ 사용법</h3>
        <h3>🎙️ 녹음하기</h3>
        <p>홈 <b>맨 아래 🎙 녹음하기</b>를 누르면 이야기 목록이 나와요. 이야기를 고르고,
        장면마다 <b>🔴</b> 를 눌러 읽고 다 읽으면 <b>■ 멈춤</b>. <b>🔊 녹음 확인</b>으로 들어볼 수 있어요.</p>
        <p class="hint">🎤 <b>좋은 소리로 담는 요령:</b> 조용한 방에서, 마이크(폰 아래쪽)를 <b>한 뼘쯤</b> 떨어뜨리고
        평소 말하듯 읽어주세요. 너무 가까우면 "퍽퍽" 소리가, 손이 마이크를 스치면 "지지직" 소리가 섞여요.</p>
        <h3>🌙 들려주기</h3>
        <p>홈에서 <b>또렷한 그림 카드</b>를 누르면 바로 들려줘요. 목소리에 맞춰 그림도 함께 넘어가요.
        <b>한 편이 끝나면 다른 이야기가 저절로 이어져요.</b> 화면을 누르면 잠깐 멈추고, 다시 누르면 이어서 들려줘요.</p>
        <p><b>🌙 쭉 들려주기</b>를 누르면 고르지 않아도 아무 이야기부터 계속 이어서 들려줘요. 재울 때 편해요.</p>
        <p>🔒 <b>화면을 꺼도 소리는 계속 나와요.</b> 잠금화면에 이야기 제목과 ⏯️ 버튼이 떠서 거기서 멈추거나 넘길 수 있어요.
        (폰·브라우저에 따라 다를 수 있어요)</p>
        <p class="hint">아직 녹음 안 한 이야기는 <b>흐릿하게</b> 보여요. 자리는 그대로라서 아기가 외운 위치가 안 바뀌어요.
        아기 화면에는 녹음으로 가는 길이 없어요(실수로 지울 일 없게).</p>
        <h3>👶 아기 이름 넣기</h3>
        <p>홈 화면 <b>제목 위 이름</b>(또는 “아기 이름 정하기”)을 누르면 바꿀 수 있어요.
        대본 속 <b>(아기 이름)</b> 자리에 쏙 들어가요.</p>
        <h3>📲 홈 화면에 추가하기 (앱처럼 쓰기)</h3>
        <ul>
          <li><b>아이폰</b>: 꼭 <b>사파리(Safari)</b>에서 → 아래 <b>공유(⬆️)</b> → <b>"홈 화면에 추가"</b></li>
          <li><b>안드로이드</b>: <b>크롬</b>에서 → <b>⋮ 메뉴</b> → <b>"홈 화면에 추가"</b></li>
        </ul>
        <p><b>카카오톡·인스타 등으로 링크를 열었다면</b>, 먼저 <b>사파리·크롬으로 열어주세요.</b><br/>
        (화면 <b>오른쪽 메뉴(⋯)</b> → <b>"다른 브라우저로 열기 / Safari로 열기"</b>)</p>
        <p class="hint">녹음은 <b>연 브라우저마다 따로 저장</b>되니, 처음부터 사파리·크롬으로 여는 게 안전해요.</p>

        <hr class="more-hr" />

        <h3 class="more-sec">💬 의견 보내기</h3>
        <p>불편한 점, 바라는 점, 응원 모두 좋아요. 만든 사람에게 전해져요.</p>
        <label class="field-label" for="fbMsg">내용</label>
        <textarea class="text-area" id="fbMsg" placeholder="자유롭게 적어주세요"></textarea>
        <label class="field-label" for="fbEmail">답장 받을 이메일 (선택)</label>
        <input class="text-input" id="fbEmail" type="email" placeholder="선택 사항이에요" />
        <button class="modal-btn" id="fbSend" type="button">보내기</button>
        <p class="hint">보낸 내용은 만든 사람에게만 전달돼요.</p>

        <hr class="more-hr" />
        <p class="hint" style="text-align:center;">🔒 녹음은 이 기기 안에만 저장돼요 · 서버에 올라가지 않아요<br/>별밤책 ${APP_VERSION}</p>
      </div>`);
    modalBody.querySelectorAll("[data-mv]").forEach((b) => b.addEventListener("click", () => {
      setMyVoice(b.dataset.mv);
      modalBody.querySelectorAll("[data-mv]").forEach((x) => x.classList.toggle("on", x === b));
      toast(`이 폰은 ${VOICE_LABEL[b.dataset.mv]} 폰이에요 🎤`);
    }));
    $("bkHist").addEventListener("change", (e) => { backupWithHistory = e.target.checked; buildBackup(); });
    $("doBackup").addEventListener("click", sendBackup);
    $("doRestore").addEventListener("click", () => restoreInput.click());
    $("fbSend").addEventListener("click", sendFeedback);
    buildBackup();   // 모달 열자마자 파일 준비 → 버튼 누르는 즉시 공유창이 뜨게
  }

  /* 의견 보내기 (더보기 모달 안 폼 → 구글 폼, 없으면 Netlify Forms)
   * 어떤 화면·어떤 버전에서 온 의견인지 알면 고치기 쉬워서, 내용 끝에 짧은 꼬리표를 붙인다.
   * (개인을 알아볼 수 있는 건 아무것도 보내지 않는다) */
  function envTag() {
    const ua = navigator.userAgent || "";
    const device = /iPad|iPhone|iPod/.test(ua) ? "아이폰·아이패드" : /Android/i.test(ua) ? "안드로이드" : "그 밖";
    const installed = (window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches)) ? " · 홈화면 앱" : "";
    return `별밤책 ${APP_VERSION} · ${device}${installed}`;
  }
  async function sendFeedback() {
    const msg = $("fbMsg").value.trim(); const email = $("fbEmail").value.trim();
    if (!msg) { toast("내용을 적어주세요"); return; }
    const btn = $("fbSend"); btn.disabled = true; btn.textContent = "보내는 중…";
    try {
      if (FEEDBACK_FORM.id && FEEDBACK_FORM.message) {
        const body = new URLSearchParams();
        body.set(FEEDBACK_FORM.message, msg + "\n\n— " + envTag());
        if (FEEDBACK_FORM.email && email) body.set(FEEDBACK_FORM.email, email);
        // 구글 폼은 다른 사이트에서 오는 요청에 답을 안 준다(no-cors) → 보냈는지 확인은 못 한다.
        //   전송 자체는 되므로, 통신이 끊긴 게 아니면 보낸 것으로 본다.
        await fetch(`https://docs.google.com/forms/d/e/${FEEDBACK_FORM.id}/formResponse`, {
          method: "POST", mode: "no-cors",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: body.toString(),
        });
      } else {
        await fetch("/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ "form-name": "feedback", message: msg, email: email, "bot-field": "" }).toString() });
      }
      toast("보내주셔서 고마워요 💛"); track("feedback"); closeModal();
    } catch (e) { toast("전송에 실패했어요. 잠시 후 다시 시도해 주세요"); btn.disabled = false; btn.textContent = "보내기"; }
  }

  // 카카오톡·인스타 등 '인앱 브라우저'인지 감지
  function isInAppBrowser() {
    const ua = navigator.userAgent || "";
    return /KAKAOTALK|Instagram|FBAN|FBAV|FB_IAB|Line\/|NAVER|DaumApps|everytimeApp|Snapchat|TikTok|; wv\)/i.test(ua);
  }
  function showIabNoticeIfNeeded() {
    if (!isInAppBrowser()) return;
    try { if (sessionStorage.getItem("iabSeen") === "1") return; sessionStorage.setItem("iabSeen", "1"); } catch (e) {}
    openModal(`
      <div class="modal-body">
        <h2>사파리·크롬으로 열어주세요 🌙</h2>
        <p>지금 <b>카카오톡·인스타 같은 앱 안</b>에서 열렸어요. 여기서도 쓸 수는 있지만,
        <b>녹음이 안전하게 저장되지 않을 수 있어요.</b></p>
        <p><b>이렇게 열어주세요:</b></p>
        <ul>
          <li>화면 <b>오른쪽 메뉴(⋯ 또는 나침반)</b> 누르기</li>
          <li><b>"다른 브라우저로 열기 / Safari로 열기"</b> 선택</li>
        </ul>
        <p class="hint">아이폰은 사파리에서만 "홈 화면에 추가"도 돼요.</p>
        <button class="modal-btn" id="iabOk" type="button">알겠어요</button>
      </div>`);
    const ok = $("iabOk"); if (ok) ok.addEventListener("click", closeModal);
  }

  /* ===== 📲 홈 화면에 추가 =====
   * 안드로이드·크롬: 브라우저가 미리 알려주는 설치 기회(beforeinstallprompt)를 붙잡아 뒀다가
   *   버튼을 누르면 바로 설치창을 띄운다.
   * 아이폰·사파리: 애플이 이 기능을 웹에 열어주지 않는다 → 자동 추가가 **불가능**하다.
   *   대신 공유(⬆️) → "홈 화면에 추가" 하는 법을 그림처럼 또박또박 알려준다.
   * 이미 홈 화면 앱으로 열었으면 띠를 아예 안 보여준다. */
  let installPrompt = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();          // 브라우저가 제멋대로 띄우지 않게 잡아 둔다
    installPrompt = e;
    /* 이 이벤트가 왔다 = **아직 설치 안 됨**이라는 확실한 신호.
     * 예전에 남긴 "설치했음" 기록을 지운다 — 안 지우면 앱을 지운 뒤에도 띠가 영영 안 뜬다. */
    try { localStorage.removeItem("installed"); } catch (e2) {}
    updateInstallBar();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    try { localStorage.setItem("installed", "1"); } catch (e) {}
    updateInstallBar();
    track("installed");
    /* 안드로이드는 새로 설치한 앱을 보통 **앱 서랍(앱 목록)** 에만 넣는다.
     * "홈 화면에 추가"를 눌렀는데 홈 화면에 없어서 당황했다는 제보가 있었다 → 두는 법을 알려준다. */
    showAddToHomeGuide();
  });
  function showAddToHomeGuide() {
    openModal(`
      <div class="modal-body">
        <h2>설치됐어요 📲</h2>
        <p>안드로이드는 새 앱을 보통 <b>앱 목록(앱 서랍)</b> 에 넣어요.
        홈 화면에도 두고 싶으면 이렇게 하세요.</p>
        <ol class="steps-big">
          <li><span>앱 목록에서 <b>별밤책</b> 을 찾으세요</span></li>
          <li><span>아이콘을 <b>꾹 누르세요</b></span></li>
          <li><span>그대로 <b>홈 화면으로 끌어다 놓으면</b> 끝!</span></li>
        </ol>
        <p class="hint">💡 <b>설정 → 홈 화면</b> 에서 <b>“새 앱 홈 화면에 추가”</b> 를 켜두면 다음부터는 저절로 들어가요.</p>
        <button class="modal-btn gold" id="ahOk" type="button">알겠어요</button>
      </div>`);
    const ok = $("ahOk"); if (ok) ok.addEventListener("click", closeModal);
  }

  function updateInstallBar() {
    if (!installBar) return;
    let already = isStandalone();
    /* "설치했음" 기록은 **설치 기회가 없을 때만** 참고한다.
     * 안드로이드에서 앱을 지우면 브라우저가 다시 설치 기회를 주는데,
     * 그때도 이 기록 때문에 띠를 숨기면 다시 설치할 길이 없어진다(v35에서 실제로 그랬다). */
    if (!already && !installPrompt) { try { already = localStorage.getItem("installed") === "1"; } catch (e) {} }
    // 인앱 브라우저(카톡 등)에서는 추가가 안 되므로 띠 대신 "사파리로 열기" 안내가 이미 뜬다.
    // 안드로이드는 설치 기회가 아직 안 왔어도 직접 하는 법을 알려줄 수 있으므로 띠를 보여준다.
    installBar.hidden = already || isInAppBrowser() || (!installPrompt && !isIOS && !isAndroid);
    // 안드로이드는 '설치'가, 아이폰은 '홈 화면에 추가'가 실제 동작에 맞는 말이다
    installBar.textContent = (installPrompt || isAndroid) ? "📲 앱으로 설치하기" : "📲 홈 화면에 앱처럼 추가하기";
  }

  function openInstallGuide() {
    // 안드로이드·크롬: 진짜 설치창을 띄운다
    if (installPrompt) {
      const p = installPrompt; installPrompt = null;
      p.prompt();
      p.userChoice.then((r) => {
        if (r && r.outcome === "accepted") {
          track("install_accept");
          // appinstalled 이벤트가 안 오는 기기도 있어서, 여기서도 한 번 안내한다
          setTimeout(() => { if (modalEl.hidden) showAddToHomeGuide(); }, 900);
        } else { installPrompt = p; updateInstallBar(); }   // 취소하면 다시 눌러볼 수 있게
      }).catch(() => {});
      return;
    }
    track("install_guide");
    // 안드로이드인데 설치 기회가 아직 안 온 경우 — 크롬 메뉴로 직접 하는 법
    if (isAndroid) {
      openModal(`
        <div class="modal-body">
          <h2>앱으로 설치하기 📲</h2>
          <p>설치하면 <b>진짜 앱처럼</b> 열려요. 주소창 없이 화면을 꽉 채우고, 다시 찾기도 쉬워요.</p>
          <ol class="steps-big">
            <li><span>화면 <b>오른쪽 위 ⋮</b> (점 세 개)를 누르세요</span></li>
            <li><span><b>“앱 설치”</b> 또는 <b>“홈 화면에 추가”</b> 를 누르세요</span></li>
            <li><span><b>“설치”</b> 를 누르면 끝!</span></li>
          </ol>
          <p class="hint">설치하면 <b>앱 목록(앱 서랍)</b> 에 들어가요.
          홈 화면에도 두고 싶으면 아이콘을 <b>꾹 눌러 끌어다 놓으세요.</b><br/>
          ※ <b>크롬</b>에서만 돼요. 카톡·인스타 안에서 열었다면 먼저 크롬으로 열어주세요.</p>
          <button class="modal-btn gold" id="igOk" type="button">알겠어요</button>
        </div>`);
      const ok2 = $("igOk"); if (ok2) ok2.addEventListener("click", closeModal);
      return;
    }
    // 아이폰: 직접 해야 해서 방법을 알려준다
    openModal(`
      <div class="modal-body">
        <h2>앱처럼 쓰기 📲</h2>
        <p>홈 화면에 추가하면 <b>진짜 앱처럼</b> 열려요. 주소창 없이 화면을 꽉 채우고, 다시 찾기도 쉬워요.</p>
        <ol class="steps-big">
          <li><span>화면 <b>아래쪽 공유 버튼 ⬆️</b> 을 누르세요<br/>
            <i class="sub">사파리 맨 아래 가운데에 있어요</i></span></li>
          <li><span>목록을 <b>쭉 내려서</b> <b>“홈 화면에 추가”</b> 를 누르세요</span></li>
          <li><span>오른쪽 위 <b>“추가”</b> 를 누르면 끝!</span></li>
        </ol>
        <p class="hint">🌙 그러면 홈 화면에 <b>별밤책</b> 이 생겨요.<br/>
        ※ <b>사파리</b>에서만 돼요. 카톡·인스타 안에서 열었다면 먼저 사파리로 열어주세요.</p>
        <button class="modal-btn gold" id="igOk" type="button">알겠어요</button>
      </div>`);
    const ok = $("igOk"); if (ok) ok.addEventListener("click", closeModal);
  }

  /* ================= 정리 ================= */
  function stopEverything() {
    stopPreview(); stopPlayback();
    if (rec.recorder && rec.recorder.state !== "inactive") { try { rec.recorder.stop(); } catch (e) {} }
    releaseStream(); rec.recorder = null; rec.recording = false;
  }

  /* ================= 이벤트 ================= */
  nameChip.addEventListener("click", openName);
  nameOwner.addEventListener("click", openName);
  $("moreBtn").addEventListener("click", openMore);
  $("shareBtn").addEventListener("click", shareApp);
  $("recEntry").addEventListener("click", showPick);
  shuffleBtn.addEventListener("click", openShuffle);
  installBar.addEventListener("click", openInstallGuide);
  $("pickHome").addEventListener("click", showHome);
  $("recHome").addEventListener("click", showHome);
  $("recBack").addEventListener("click", showPick);
  document.querySelectorAll(".vtab").forEach((t) => t.addEventListener("click", () => setVoice(t.dataset.voice)));
  $("playHome").addEventListener("click", (e) => { e.stopPropagation(); showHome(); });
  $("modalClose").addEventListener("click", closeModal);
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) closeModal(); });
  restoreInput.addEventListener("change", (e) => { restoreFromFile(e.target.files[0]); e.target.value = ""; });
  document.addEventListener("keydown", (e) => {
    if (!recEl.classList.contains("active") || rec.recording) return;
    if (e.key === "ArrowLeft") goScene(rec.scene - 1);
    else if (e.key === "ArrowRight") goScene(rec.scene + 1);
  });
  window.addEventListener("pagehide", stopEverything);

  /* ================= 시작 ================= */
  // 화면 높이 맞추기.
  // - 홈 화면 앱(설치본): 툴바가 없으므로 CSS 100dvh(전체화면)를 그대로 쓴다 → 여백 없음.
  // - 사파리 등 브라우저: 툴바 때문에 어긋나므로 실제 보이는 높이를 직접 재서 맞춘다.
  function setAppHeight() {
    // 기본: 실제 보이는 높이(브라우저·안드로이드·아이패드 모두 이게 맞음)
    let h = (window.visualViewport && window.visualViewport.height) || window.innerHeight || 0;
    // iOS 홈 화면 앱만: 화면 높이를 상단 안전영역만큼 '작게' 주는 버그가 있어, 더 큰 실제 화면 높이로 보정.
    if (isStandalone() && isIOS) {
      const scr = (window.screen && window.screen.height) || 0;
      if (scr > h) h = scr;
    }
    if (h) document.documentElement.style.setProperty("--app-height", h + "px");
  }
  setAppHeight();
  window.addEventListener("resize", setAppHeight);
  window.addEventListener("orientationchange", setAppHeight);
  window.addEventListener("load", setAppHeight);
  window.addEventListener("pageshow", setAppHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", setAppHeight);
    window.visualViewport.addEventListener("scroll", setAppHeight);
  }

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  updateNameUI();
  renderHome().then(importDemoClipsOnce);
  showIabNoticeIfNeeded();
})();
