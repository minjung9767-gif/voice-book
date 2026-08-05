/* =========================================================
 * 우리 목소리 책 — 앱 로직
 * - 녹음(MediaRecorder) → 이 기기 IndexedDB에 저장 → 재생
 * - 목소리는 엄마/아빠 두 종류, 이야기별로 따로 저장
 * - 저장 열쇠(key): `${scriptId}:${voice}`
 * 데이터는 기기 밖으로 나가지 않는다(서버 없음).
 * ========================================================= */

(() => {
  "use strict";

  const VOICE_LABEL = { mom: "엄마", dad: "아빠" };
  const MAX_SECONDS = 300; // 녹음 최대 5분 (동화 한 편 읽기 넉넉하게)

  // ---- 상태 ----
  const state = {
    scriptId: null,
    voice: "mom",
    mode: "idle",      // idle | recording | review
    saved: new Set(),  // 저장된 key 모음 (홈 배지/도크 표시용)
    recorder: null,
    chunks: [],
    stream: null,
    pending: null,     // { blob, mime } 녹음했지만 아직 저장 안 한 것
    timer: null,
    startTs: 0,
    audio: null,       // 재생용 Audio
    audioUrl: null,
  };

  // ---- DOM ----
  const $ = (id) => document.getElementById(id);
  const homeEl = $("home");
  const storyEl = $("story");
  const listEl = $("scriptList");
  const bodyEl = $("scriptBody");
  const titleEl = $("storyTitle");
  const dockStatus = $("dockStatus");
  const dockControls = $("dockControls");
  const importInput = $("importInput");
  const toastEl = $("toast");
  const playerEl = $("player");
  const playerLineEl = $("playerLine");
  const playerTitleEl = $("playerTitle");
  const playerDotsEl = $("playerDots");
  const playPauseBtn = $("playPause");
  const shuffleBtn = $("shuffleToggle");

  // 보기 화면(아기용) 상태
  const player = {
    active: false, scriptId: null, voice: "mom",
    lines: [], idx: -1, audio: null, url: null,
    perLine: 0, fallbackTimer: null, shuffle: false,
  };

  const scriptById = (id) => window.SCRIPTS.find((s) => s.id === id);
  const curKey = () => `${state.scriptId}:${state.voice}`;

  /* ================= IndexedDB ================= */
  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("voicebook", 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("recordings", { keyPath: "key" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function dbGet(key) {
    const d = await db();
    return new Promise((res, rej) => {
      const r = d.transaction("recordings").objectStore("recordings").get(key);
      r.onsuccess = () => res(r.result || null);
      r.onerror = () => rej(r.error);
    });
  }
  async function dbPut(value) {
    const d = await db();
    return new Promise((res, rej) => {
      const r = d.transaction("recordings", "readwrite").objectStore("recordings").put(value);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }
  async function dbDelete(key) {
    const d = await db();
    return new Promise((res, rej) => {
      const r = d.transaction("recordings", "readwrite").objectStore("recordings").delete(key);
      r.onsuccess = () => res();
      r.onerror = () => rej(r.error);
    });
  }
  async function dbAllKeys() {
    const d = await db();
    return new Promise((res, rej) => {
      const r = d.transaction("recordings").objectStore("recordings").getAllKeys();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => rej(r.error);
    });
  }

  /* ================= 유틸 ================= */
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2400);
  }
  function fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  function pickMime() {
    const cand = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/aac",
      "audio/ogg;codecs=opus",
    ];
    if (window.MediaRecorder && MediaRecorder.isTypeSupported) {
      for (const t of cand) if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return ""; // 브라우저 기본값
  }
  function extFor(mime) {
    if (!mime) return "webm";
    if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
    if (mime.includes("ogg")) return "ogg";
    return "webm";
  }

  /* ================= 홈 화면 ================= */
  async function renderHome() {
    const keys = await dbAllKeys();
    state.saved = new Set(keys);
    listEl.innerHTML = "";
    for (const s of window.SCRIPTS) {
      const hasMom = state.saved.has(`${s.id}:mom`);
      const hasDad = state.saved.has(`${s.id}:dad`);
      const li = document.createElement("li");
      li.className = "script-card";
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.innerHTML = `
        <span class="card-emoji" aria-hidden="true">${s.emoji}</span>
        <span class="card-text">
          <span class="card-title">${s.title}</span>
          <span class="card-badges">${
            hasMom || hasDad
              ? `${hasMom ? '<span class="badge mom">🎙️ 엄마</span>' : ""}${hasDad ? '<span class="badge dad">🎙️ 아빠</span>' : ""}`
              : '<span class="badge empty">아직 녹음 전</span>'
          }</span>
        </span>
        <span class="card-arrow" aria-hidden="true">›</span>`;
      const open = () => openStory(s.id);
      li.addEventListener("click", open);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
      });
      listEl.appendChild(li);
    }
  }

  function showHome() {
    stopEverything();
    storyEl.classList.remove("active");
    playerEl.classList.remove("active");
    homeEl.classList.add("active");
    state.scriptId = null;
    renderHome();
  }

  /* ================= 이야기 화면 ================= */
  function openStory(id) {
    const s = scriptById(id);
    if (!s) return;
    state.scriptId = id;
    state.voice = "mom";
    state.mode = "idle";
    titleEl.textContent = s.title;
    bodyEl.innerHTML = s.lines.map((l) => `<p class="line">${l}</p>`).join("");
    document.querySelectorAll(".voice-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.voice === "mom");
    });
    homeEl.classList.remove("active");
    storyEl.classList.add("active");
    storyEl.scrollTop = 0;
    refreshDock();
  }

  function selectVoice(voice) {
    if (voice === state.voice) return;
    if (state.mode === "recording") { toast("녹음 중에는 바꿀 수 없어요"); return; }
    discardPending();
    state.voice = voice;
    state.mode = "idle";
    document.querySelectorAll(".voice-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.voice === voice);
    });
    refreshDock();
  }

  /* ================= 도크(녹음/재생 조작판) ================= */
  async function refreshDock() {
    stopPlayback();
    const has = await dbGet(curKey());
    const label = VOICE_LABEL[state.voice];

    if (state.mode === "recording") {
      dockStatus.innerHTML = `<span class="rec-dot"></span> 녹음 중 <b id="recTime">0:00</b>`;
      dockControls.innerHTML = "";
      addBtn("■ 정지", "btn-stop big", stopRecording);
      return;
    }

    if (state.mode === "review") {
      dockStatus.textContent = "녹음 완료! 들어보고 저장하세요 👂";
      dockControls.innerHTML = "";
      addBtn("▶ 미리듣기", "btn-play", () => playPending());
      addBtn("💾 저장", "btn-save", savePending);
      addBtn("↺ 다시", "btn-ghost", () => { discardPending(); refreshDock(); });
      return;
    }

    // idle
    if (has) {
      dockStatus.innerHTML = `🎙️ <b>${label}</b> 목소리로 녹음돼 있어요`;
      dockControls.innerHTML = "";
      addBtn("▶ 들려주기", "btn-play big", () => openPlayer());
      addBtn("🔴 다시 녹음", "btn-ghost", startRecording);
      addBtn("⬇ 내려받기", "btn-ghost", () => downloadSaved(has));
      addBtn("🗑 지우기", "btn-ghost danger", () => deleteSaved());
    } else {
      dockStatus.innerHTML = `아직 <b>${label}</b> 목소리 녹음이 없어요`;
      dockControls.innerHTML = "";
      addBtn("🔴 녹음하기", "btn-rec big", startRecording);
      addBtn("📁 파일 불러오기", "btn-ghost", () => importInput.click());
    }
  }

  function addBtn(label, cls, onClick) {
    const b = document.createElement("button");
    b.className = "dock-btn " + cls;
    b.textContent = label;
    b.addEventListener("click", onClick);
    dockControls.appendChild(b);
  }

  /* ================= 녹음 ================= */
  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      toast("이 브라우저는 녹음을 지원하지 않아요");
      return;
    }
    stopPlayback();
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      toast("마이크 사용을 허용해 주세요 🎤");
      return;
    }
    const mime = pickMime();
    try {
      state.recorder = mime
        ? new MediaRecorder(state.stream, { mimeType: mime })
        : new MediaRecorder(state.stream);
    } catch (e) {
      state.recorder = new MediaRecorder(state.stream);
    }
    state.chunks = [];
    state.recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
    state.recorder.onstop = onRecorderStop;
    state.recorder.start();
    state.mode = "recording";
    state.startTs = Date.now();
    refreshDock();
    startTimer();
  }

  function startTimer() {
    stopTimer();
    state.timer = setInterval(() => {
      const sec = Math.floor((Date.now() - state.startTs) / 1000);
      const t = $("recTime");
      if (t) t.textContent = fmtTime(sec);
      if (sec >= MAX_SECONDS) { toast("최대 5분까지 녹음돼요"); stopRecording(); }
    }, 250);
  }
  function stopTimer() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  function stopRecording() {
    if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
    stopTimer();
  }

  function onRecorderStop() {
    const mime = (state.recorder && state.recorder.mimeType) || pickMime() || "audio/webm";
    const blob = new Blob(state.chunks, { type: mime });
    releaseStream();
    state.recorder = null;
    if (!blob.size) { toast("녹음이 비어 있어요. 다시 해볼까요?"); state.mode = "idle"; refreshDock(); return; }
    state.pending = { blob, mime };
    state.mode = "review";
    refreshDock();
  }

  function releaseStream() {
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
  }

  async function savePending() {
    if (!state.pending) return;
    try {
      await dbPut({
        key: curKey(),
        scriptId: state.scriptId,
        voice: state.voice,
        blob: state.pending.blob,
        mime: state.pending.mime,
        createdAt: Date.now(),
      });
      state.saved.add(curKey());
      state.pending = null;
      state.mode = "idle";
      toast("저장했어요 💾");
      track("record_save");
      refreshDock();
    } catch (e) {
      toast("저장에 실패했어요 (저장 공간을 확인해 주세요)");
    }
  }

  function discardPending() {
    state.pending = null;
    if (state.mode === "review") state.mode = "idle";
  }

  /* ================= 재생 ================= */
  function playBlob(blob, btnLabelOnEnd) {
    stopPlayback();
    state.audioUrl = URL.createObjectURL(blob);
    state.audio = new Audio(state.audioUrl);
    state.audio.play().catch(() => toast("재생할 수 없어요"));
  }
  function playPending() {
    if (!state.pending) return;
    if (isPlaying()) { stopPlayback(); refreshDock(); return; }
    playBlob(state.pending.blob);
  }
  function isPlaying() { return state.audio && !state.audio.paused; }
  function stopPlayback() {
    if (state.audio) { try { state.audio.pause(); } catch (e) {} state.audio = null; }
    cleanupAudioUrl();
  }
  function cleanupAudioUrl() {
    if (state.audioUrl) { URL.revokeObjectURL(state.audioUrl); state.audioUrl = null; }
  }

  /* ================= 내려받기 / 지우기 / 불러오기 ================= */
  function downloadSaved(rec) {
    const s = scriptById(state.scriptId);
    const name = `${s ? s.title : "녹음"}-${VOICE_LABEL[state.voice]}.${extFor(rec.mime)}`;
    const url = URL.createObjectURL(rec.blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    toast("파일로 내려받았어요 ⬇");
  }

  async function deleteSaved() {
    if (!confirm(`${VOICE_LABEL[state.voice]} 목소리 녹음을 지울까요? 되돌릴 수 없어요.`)) return;
    await dbDelete(curKey());
    state.saved.delete(curKey());
    toast("지웠어요");
    refreshDock();
  }

  async function onImportFile(file) {
    if (!file) return;
    if (!file.type.startsWith("audio/")) { toast("오디오 파일만 불러올 수 있어요"); return; }
    try {
      await dbPut({
        key: curKey(),
        scriptId: state.scriptId,
        voice: state.voice,
        blob: file,
        mime: file.type,
        createdAt: Date.now(),
      });
      state.saved.add(curKey());
      toast("불러왔어요 📁");
      refreshDock();
    } catch (e) {
      toast("불러오기에 실패했어요");
    }
  }

  /* ================= 보기 화면 (아기용, 자동 넘김 + 랜덤 이어재생) ================= */
  function updateShuffleBtn() {
    shuffleBtn.classList.toggle("on", player.shuffle);
    shuffleBtn.setAttribute("aria-pressed", player.shuffle ? "true" : "false");
    shuffleBtn.textContent = player.shuffle ? "🔀 이어서 자동 재생 ✓" : "🔀 이어서 자동 재생";
  }
  function toggleShuffle() {
    player.shuffle = !player.shuffle;
    try { localStorage.setItem("autoNext", player.shuffle ? "1" : "0"); } catch (e) {}
    updateShuffleBtn();
    if (player.shuffle) track("shuffle_on");
  }

  async function openPlayer(id, voice) {
    id = id || state.scriptId;
    voice = voice || state.voice;
    const s = scriptById(id);
    if (!s) return;
    const rec = await dbGet(`${id}:${voice}`);
    if (!rec) { toast("먼저 녹음을 해주세요"); return; }
    try { state.saved = new Set(await dbAllKeys()); } catch (e) {} // 랜덤용 목록 최신화
    stopPlayback(); // 미리듣기 오디오 정리
    player.voice = voice;
    homeEl.classList.remove("active");
    storyEl.classList.remove("active");
    playerEl.classList.add("active");
    playInPlayer(s, rec);
    track("play");
  }

  function playInPlayer(s, rec) {
    stopPlayerAudio();
    player.active = true;
    player.scriptId = s.id;
    player.lines = s.lines;
    player.idx = -1;
    player.perLine = 0;
    playerTitleEl.textContent = s.title;
    buildDots(s.lines.length);
    showPlayerLine(0);

    player.url = URL.createObjectURL(rec.blob);
    const a = new Audio(player.url);
    player.audio = a;

    const setPerLine = () => {
      if (isFinite(a.duration) && a.duration > 0) player.perLine = a.duration / s.lines.length;
    };
    a.addEventListener("loadedmetadata", () => {
      if (!isFinite(a.duration)) {
        // 일부 webm 녹음은 duration 이 Infinity → 강제로 계산시키는 알려진 방법
        a.currentTime = 1e101;
        a.addEventListener("timeupdate", function once() {
          a.removeEventListener("timeupdate", once);
          try { a.currentTime = 0; } catch (e) {}
          setPerLine();
          startFallbackIfNeeded(s.lines.length);
        });
      } else {
        setPerLine();
      }
    });
    a.addEventListener("timeupdate", () => {
      if (player.perLine > 0) {
        const i = Math.min(s.lines.length - 1, Math.floor(a.currentTime / player.perLine));
        if (i !== player.idx) showPlayerLine(i);
      }
    });
    a.addEventListener("ended", onPlayerEnded);
    setPlayPause(true);
    a.play().catch(() => { toast("재생할 수 없어요"); setPlayPause(false); });
  }

  // duration 을 못 구하는 경우(webm Infinity)에만 시간 기반으로 대체 넘김
  function startFallbackIfNeeded(n) {
    if (player.perLine > 0) return;
    stopFallback();
    player.fallbackTimer = setInterval(() => {
      if (!player.audio || player.audio.paused) return;
      const next = player.idx + 1;
      if (next < n) showPlayerLine(next);
    }, 4500);
  }
  function stopFallback() { if (player.fallbackTimer) { clearInterval(player.fallbackTimer); player.fallbackTimer = null; } }

  function buildDots(n) {
    playerDotsEl.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const d = document.createElement("span");
      d.className = "dot";
      playerDotsEl.appendChild(d);
    }
  }
  function showPlayerLine(i) {
    player.idx = i;
    playerLineEl.classList.add("fade");
    setTimeout(() => {
      playerLineEl.textContent = player.lines[i] || "";
      playerLineEl.classList.remove("fade");
    }, 180);
    const dots = playerDotsEl.children;
    for (let k = 0; k < dots.length; k++) dots[k].classList.toggle("on", k === i);
  }

  function setPlayPause(playing) { playPauseBtn.textContent = playing ? "⏸ 멈춤" : "▶ 다시"; }
  function togglePlayPause() {
    const a = player.audio;
    if (!a) { replayCurrent(); return; }
    if (a.paused) { a.play(); setPlayPause(true); }
    else { a.pause(); setPlayPause(false); }
  }
  function replayCurrent() {
    const s = scriptById(player.scriptId);
    if (!s) return;
    dbGet(`${s.id}:${player.voice}`).then((rec) => { if (rec) playInPlayer(s, rec); });
  }

  async function onPlayerEnded() {
    if (player.shuffle) {
      const next = nextRecordedStory(player.scriptId, player.voice);
      if (next) {
        const rec = await dbGet(`${next.id}:${player.voice}`);
        if (rec) { playInPlayer(next, rec); track("auto_next"); return; }
      }
    }
    stopFallback();
    stopPlayerAudio();
    showPlayerEndState();
  }
  function showPlayerEndState() {
    player.lines = ["잘 자요 🌙"];
    buildDots(1);
    showPlayerLine(0);
    setPlayPause(false); // "▶ 다시" 로
  }

  // 현재 목소리로 녹음된 다른 이야기 중 하나를 랜덤으로 (하나뿐이면 그것 반복)
  function nextRecordedStory(currentId, voice) {
    const recorded = window.SCRIPTS.filter((s) => state.saved.has(`${s.id}:${voice}`));
    if (recorded.length === 0) return null;
    let pool = recorded.filter((s) => s.id !== currentId);
    if (pool.length === 0) pool = recorded;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function stopPlayerAudio() {
    stopFallback();
    if (player.audio) { try { player.audio.pause(); } catch (e) {} player.audio = null; }
    if (player.url) { URL.revokeObjectURL(player.url); player.url = null; }
  }
  function closePlayer() {
    stopPlayerAudio();
    player.active = false;
    playerEl.classList.remove("active");
    if (state.scriptId) { storyEl.classList.add("active"); refreshDock(); }
    else { homeEl.classList.add("active"); }
  }

  /* ================= 정리 ================= */
  function stopEverything() {
    stopTimer();
    stopPlayback();
    stopPlayerAudio();
    if (state.recorder && state.recorder.state !== "inactive") { try { state.recorder.stop(); } catch (e) {} }
    releaseStream();
    state.recorder = null;
    state.pending = null;
    state.mode = "idle";
  }

  /* ================= 이벤트 연결 ================= */
  $("backBtn").addEventListener("click", showHome);
  document.querySelectorAll(".voice-tab").forEach((t) => {
    t.addEventListener("click", () => selectVoice(t.dataset.voice));
  });
  importInput.addEventListener("change", (e) => {
    onImportFile(e.target.files[0]);
    e.target.value = "";
  });
  $("playerClose").addEventListener("click", closePlayer);
  playPauseBtn.addEventListener("click", togglePlayPause);
  shuffleBtn.addEventListener("click", toggleShuffle);
  window.addEventListener("pagehide", stopEverything);

  // 랜덤 이어재생 설정 불러오기
  try { player.shuffle = localStorage.getItem("autoNext") === "1"; } catch (e) {}
  updateShuffleBtn();

  /* ================= 시작 ================= */
  // 저장이 잘 유지되도록(브라우저가 함부로 지우지 않도록) 요청
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }
  // 서비스워커 등록(오프라인 + 홈화면 앱)
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
  renderHome();
})();
