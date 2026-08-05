/* =========================================================
 * 별밤책 — 앱 로직
 * - 녹음(MediaRecorder) → 이 기기 IndexedDB에 저장 → 재생
 * - 목소리는 엄마/아빠, 이야기별로 따로 저장 (열쇠: `${scriptId}:${voice}`)
 * - 아기 이름 넣기, 전체 백업/복원, 도움말, 의견 보내기
 * 데이터는 기기 밖으로 나가지 않는다(서버 없음).
 * ========================================================= */
(() => {
  "use strict";

  const VOICE_LABEL = { mom: "엄마", dad: "아빠" };
  const MAX_SECONDS = 300;
  const APP_VERSION = "v13";

  const state = {
    scriptId: null, voice: "mom", mode: "idle",
    saved: new Set(), recorder: null, chunks: [], stream: null,
    pending: null, timer: null, startTs: 0, audio: null, audioUrl: null,
  };
  const player = { active: false, scriptId: null, voice: "mom", audio: null, url: null, shuffle: false };

  const $ = (id) => document.getElementById(id);
  const homeEl = $("home"), storyEl = $("story"), playerEl = $("player");
  const listEl = $("scriptList"), bodyEl = $("scriptBody"), titleEl = $("storyTitle");
  const dockStatus = $("dockStatus"), dockControls = $("dockControls");
  const importInput = $("importInput"), restoreInput = $("restoreInput"), toastEl = $("toast");
  const moodEmoji = $("moodEmoji"), moodTitle = $("moodTitle");
  const playPauseBtn = $("playPause"), shuffleBtn = $("shuffleToggle");
  const nameChip = $("nameChip");
  const modalEl = $("modal"), modalBody = $("modalBody");

  const scriptById = (id) => window.SCRIPTS.find((s) => s.id === id);
  const curKey = () => `${state.scriptId}:${state.voice}`;

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
  function tx(store, mode) { return db().then((d) => d.transaction(store, mode).objectStore(store)); }
  async function dbGet(key) { const s = await tx("recordings"); return new Promise((res, rej) => { const r = s.get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); }); }
  async function dbPut(v) { const s = await tx("recordings", "readwrite"); return new Promise((res, rej) => { const r = s.put(v); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
  async function dbDelete(key) { const s = await tx("recordings", "readwrite"); return new Promise((res, rej) => { const r = s.delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
  async function dbAllKeys() { const s = await tx("recordings"); return new Promise((res, rej) => { const r = s.getAllKeys(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }
  async function dbAll() { const s = await tx("recordings"); return new Promise((res, rej) => { const r = s.getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }

  /* ================= 유틸 ================= */
  let toastTimer = null;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add("show"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600); }
  function fmtTime(s) { return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  function pickMime() {
    const cand = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/aac", "audio/ogg;codecs=opus"];
    if (window.MediaRecorder && MediaRecorder.isTypeSupported) { for (const t of cand) if (MediaRecorder.isTypeSupported(t)) return t; }
    return "";
  }
  function extFor(m) { if (!m) return "webm"; if (m.includes("mp4") || m.includes("aac")) return "m4a"; if (m.includes("ogg")) return "ogg"; return "webm"; }
  function blobToDataURL(b) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); }); }
  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  // 공유 창으로 저장할 곳(파일 앱·아이클라우드·카톡 등)을 고르게. 안 되면 그냥 내려받기.
  async function shareOrDownload(blob, name, text) {
    try {
      const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name, text: text || name });
        return "shared";
      }
    } catch (e) { if (e && e.name === "AbortError") return "cancel"; }
    downloadBlob(blob, name);
    return "download";
  }

  /* ================= 아기 이름 ================= */
  function getBabyName() { try { return (localStorage.getItem("babyName") || "").trim(); } catch (e) { return ""; } }
  function josaAh(name) {
    if (!name) return "야";
    const code = name.charCodeAt(name.length - 1);
    if (code >= 0xAC00 && code <= 0xD7A3) return ((code - 0xAC00) % 28 === 0) ? "야" : "아";
    return "야";
  }
  // "{이름아}" → "(지우)야" / "(아기 이름)야"
  function renderName(text) {
    const name = getBabyName();
    const shown = name || "아기 이름";
    const josa = josaAh(name);
    return text.replace(/\{이름아\}/g, '<span class="namebox">(' + escapeHtml(shown) + ')' + josa + '</span>');
  }
  function updateNameChip() {
    const name = getBabyName();
    if (name) { nameChip.textContent = "👶 " + name; nameChip.classList.add("set"); }
    else { nameChip.textContent = "👶 아기 이름 정하기"; nameChip.classList.remove("set"); }
  }

  /* ================= 홈 화면 ================= */
  async function renderHome() {
    state.saved = new Set(await dbAllKeys());
    updateNameChip();
    listEl.innerHTML = "";
    for (const s of window.SCRIPTS) {
      const hasMom = state.saved.has(`${s.id}:mom`), hasDad = state.saved.has(`${s.id}:dad`);
      const li = document.createElement("li");
      li.className = "script-card"; li.tabIndex = 0; li.setAttribute("role", "button");
      li.innerHTML = `
        <span class="card-emoji" aria-hidden="true">${s.emoji}</span>
        <span class="card-text">
          <span class="card-title">${escapeHtml(s.title)}</span>
          <span class="card-badges">${
            hasMom || hasDad
              ? `${hasMom ? '<span class="badge mom">🎙️ 엄마</span>' : ""}${hasDad ? '<span class="badge dad">🎙️ 아빠</span>' : ""}`
              : '<span class="badge empty">아직 녹음 전</span>'
          }</span>
        </span>
        <span class="card-arrow" aria-hidden="true">›</span>`;
      const open = () => openStory(s.id);
      li.addEventListener("click", open);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
      listEl.appendChild(li);
    }
  }
  function showHome() {
    stopEverything();
    storyEl.classList.remove("active"); playerEl.classList.remove("active");
    homeEl.classList.add("active"); state.scriptId = null; renderHome();
  }

  /* ================= 이야기 화면 ================= */
  function renderScriptBody() {
    const s = scriptById(state.scriptId); if (!s) return;
    bodyEl.innerHTML = s.lines.map((l) => `<p class="line">${renderName(l)}</p>`).join("");
    bodyEl.scrollTop = 0; // 항상 맨 위부터 (스크롤 버그 수정)
  }
  function openStory(id) {
    const s = scriptById(id); if (!s) return;
    state.scriptId = id; state.voice = "mom"; state.mode = "idle";
    titleEl.textContent = s.title;
    document.querySelectorAll(".voice-tab").forEach((t) => t.classList.toggle("active", t.dataset.voice === "mom"));
    homeEl.classList.remove("active"); storyEl.classList.add("active");
    renderScriptBody();
    refreshDock();
  }
  function selectVoice(voice) {
    if (voice === state.voice) return;
    if (state.mode === "recording") { toast("녹음 중에는 바꿀 수 없어요"); return; }
    discardPending(); state.voice = voice; state.mode = "idle";
    document.querySelectorAll(".voice-tab").forEach((t) => t.classList.toggle("active", t.dataset.voice === voice));
    refreshDock();
  }

  /* ================= 도크 ================= */
  async function refreshDock() {
    stopPlayback();
    const has = await dbGet(curKey()); const label = VOICE_LABEL[state.voice];
    if (state.mode === "recording") {
      dockStatus.innerHTML = `<span class="rec-dot"></span> 녹음 중 <b id="recTime">0:00</b>`;
      dockControls.innerHTML = ""; addBtn("■ 정지", "btn-stop big", stopRecording); return;
    }
    if (state.mode === "review") {
      dockStatus.textContent = "녹음 완료! 들어보고 저장하세요 👂";
      dockControls.innerHTML = "";
      addBtn("▶ 미리듣기", "btn-play", playPending);
      addBtn("💾 저장", "btn-save", savePending);
      addBtn("↺ 다시", "btn-ghost", () => { discardPending(); refreshDock(); });
      return;
    }
    if (has) {
      dockStatus.innerHTML = `🎙️ <b>${label}</b> 목소리로 녹음돼 있어요`;
      dockControls.innerHTML = "";
      addBtn("▶ 들려주기", "btn-play big", () => openPlayer());
      addBtn("🔴 다시 녹음", "btn-ghost", startRecording);
      addBtn("⬇ 내려받기", "btn-ghost", () => downloadSaved(has));
      addBtn("🗑 지우기", "btn-ghost danger", deleteSaved);
    } else {
      dockStatus.innerHTML = `아직 <b>${label}</b> 목소리 녹음이 없어요`;
      dockControls.innerHTML = "";
      addBtn("🔴 녹음하기", "btn-rec big", startRecording);
      addBtn("📁 파일 불러오기", "btn-ghost", () => importInput.click());
    }
  }
  function addBtn(label, cls, onClick) {
    const b = document.createElement("button"); b.className = "dock-btn " + cls; b.textContent = label;
    b.addEventListener("click", onClick); dockControls.appendChild(b);
  }

  /* ================= 녹음 ================= */
  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) { toast("이 브라우저는 녹음을 지원하지 않아요"); return; }
    stopPlayback();
    try { state.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast("마이크 사용을 허용해 주세요 🎤"); return; }
    const mime = pickMime();
    try { state.recorder = mime ? new MediaRecorder(state.stream, { mimeType: mime }) : new MediaRecorder(state.stream); }
    catch (e) { state.recorder = new MediaRecorder(state.stream); }
    state.chunks = [];
    state.recorder.ondataavailable = (e) => { if (e.data && e.data.size) state.chunks.push(e.data); };
    state.recorder.onstop = onRecorderStop;
    state.recorder.start(); state.mode = "recording"; state.startTs = Date.now();
    refreshDock(); startTimer();
  }
  function startTimer() {
    stopTimer();
    state.timer = setInterval(() => {
      const sec = Math.floor((Date.now() - state.startTs) / 1000);
      const t = $("recTime"); if (t) t.textContent = fmtTime(sec);
      if (sec >= MAX_SECONDS) { toast("최대 5분까지 녹음돼요"); stopRecording(); }
    }, 250);
  }
  function stopTimer() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }
  function stopRecording() { if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop(); stopTimer(); }
  function onRecorderStop() {
    const mime = (state.recorder && state.recorder.mimeType) || pickMime() || "audio/webm";
    const blob = new Blob(state.chunks, { type: mime });
    releaseStream(); state.recorder = null;
    if (!blob.size) { toast("녹음이 비어 있어요. 다시 해볼까요?"); state.mode = "idle"; refreshDock(); return; }
    state.pending = { blob, mime }; state.mode = "review"; refreshDock();
  }
  function releaseStream() { if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; } }
  async function savePending() {
    if (!state.pending) return;
    try {
      await dbPut({ key: curKey(), scriptId: state.scriptId, voice: state.voice, blob: state.pending.blob, mime: state.pending.mime, createdAt: Date.now() });
      state.saved.add(curKey()); state.pending = null; state.mode = "idle";
      toast("저장했어요 💾  (백업도 잊지 마세요!)"); track("record_save"); refreshDock();
    } catch (e) { toast("저장에 실패했어요 (저장 공간을 확인해 주세요)"); }
  }
  function discardPending() { state.pending = null; if (state.mode === "review") state.mode = "idle"; }

  /* ================= 미리듣기(리뷰) ================= */
  function playBlob(blob) { stopPlayback(); state.audioUrl = URL.createObjectURL(blob); state.audio = new Audio(state.audioUrl); state.audio.play().catch(() => toast("재생할 수 없어요")); }
  function playPending() { if (!state.pending) return; if (isPlaying()) { stopPlayback(); refreshDock(); return; } playBlob(state.pending.blob); }
  function isPlaying() { return state.audio && !state.audio.paused; }
  function stopPlayback() { if (state.audio) { try { state.audio.pause(); } catch (e) {} state.audio = null; } if (state.audioUrl) { URL.revokeObjectURL(state.audioUrl); state.audioUrl = null; } }

  /* ================= 보기 화면 (밤 무드등 + 목소리) ================= */
  function updateShuffleBtn() {
    shuffleBtn.classList.toggle("on", player.shuffle);
    shuffleBtn.setAttribute("aria-pressed", player.shuffle ? "true" : "false");
    shuffleBtn.textContent = player.shuffle ? "🔀 이어서 자동 재생 ✓" : "🔀 이어서 자동 재생";
  }
  function toggleShuffle() {
    player.shuffle = !player.shuffle;
    try { localStorage.setItem("autoNext", player.shuffle ? "1" : "0"); } catch (e) {}
    updateShuffleBtn(); if (player.shuffle) track("shuffle_on");
  }
  async function openPlayer(id, voice) {
    id = id || state.scriptId; voice = voice || state.voice;
    const s = scriptById(id); if (!s) return;
    const rec = await dbGet(`${id}:${voice}`);
    if (!rec) { toast("먼저 녹음을 해주세요"); return; }
    try { state.saved = new Set(await dbAllKeys()); } catch (e) {}
    stopPlayback(); player.voice = voice;
    homeEl.classList.remove("active"); storyEl.classList.remove("active"); playerEl.classList.add("active");
    playInPlayer(s, rec); track("play");
  }
  function playInPlayer(s, rec) {
    stopPlayerAudio(); player.active = true; player.scriptId = s.id;
    moodEmoji.textContent = s.emoji; moodTitle.textContent = s.title;
    player.url = URL.createObjectURL(rec.blob);
    const a = new Audio(player.url); player.audio = a;
    a.addEventListener("ended", onPlayerEnded);
    setPlayPause(true);
    a.play().catch(() => { toast("재생할 수 없어요"); setPlayPause(false); });
  }
  function setPlayPause(playing) { playPauseBtn.textContent = playing ? "⏸ 멈춤" : "▶ 다시"; }
  function togglePlayPause() {
    const a = player.audio;
    if (!a) { replayCurrent(); return; }
    if (a.paused) { a.play(); setPlayPause(true); } else { a.pause(); setPlayPause(false); }
  }
  function replayCurrent() { const s = scriptById(player.scriptId); if (!s) return; dbGet(`${s.id}:${player.voice}`).then((rec) => { if (rec) playInPlayer(s, rec); }); }
  async function onPlayerEnded() {
    if (player.shuffle) {
      const next = nextRecordedStory(player.scriptId, player.voice);
      if (next) { const rec = await dbGet(`${next.id}:${player.voice}`); if (rec) { playInPlayer(next, rec); track("auto_next"); return; } }
    }
    stopPlayerAudio(); moodEmoji.textContent = "🌙"; moodTitle.textContent = "잘 자요"; setPlayPause(false);
  }
  function nextRecordedStory(currentId, voice) {
    const recorded = window.SCRIPTS.filter((s) => state.saved.has(`${s.id}:${voice}`));
    if (recorded.length === 0) return null;
    let pool = recorded.filter((s) => s.id !== currentId);
    if (pool.length === 0) pool = recorded;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function stopPlayerAudio() { if (player.audio) { try { player.audio.pause(); } catch (e) {} player.audio = null; } if (player.url) { URL.revokeObjectURL(player.url); player.url = null; } }
  function closePlayer() {
    stopPlayerAudio(); player.active = false; playerEl.classList.remove("active");
    if (state.scriptId) { storyEl.classList.add("active"); refreshDock(); } else { homeEl.classList.add("active"); }
  }

  /* ================= 내려받기 / 지우기 / 불러오기 ================= */
  function downloadSaved(rec) {
    const s = scriptById(state.scriptId);
    downloadBlob(rec.blob, `${s ? s.title : "녹음"}-${VOICE_LABEL[state.voice]}.${extFor(rec.mime)}`);
    toast("파일로 내려받았어요 ⬇");
  }
  async function deleteSaved() {
    if (!confirm(`${VOICE_LABEL[state.voice]} 목소리 녹음을 지울까요? 되돌릴 수 없어요.`)) return;
    await dbDelete(curKey()); state.saved.delete(curKey()); toast("지웠어요"); refreshDock();
  }
  async function onImportFile(file) {
    if (!file) return;
    if (!file.type.startsWith("audio/")) { toast("오디오 파일만 불러올 수 있어요"); return; }
    try {
      await dbPut({ key: curKey(), scriptId: state.scriptId, voice: state.voice, blob: file, mime: file.type, createdAt: Date.now() });
      state.saved.add(curKey()); toast("불러왔어요 📁"); refreshDock();
    } catch (e) { toast("불러오기에 실패했어요"); }
  }

  /* ================= 전체 백업 / 복원 ================= */
  async function backupAll() {
    const all = await dbAll();
    if (!all.length) { toast("백업할 녹음이 없어요"); return; }
    const items = [];
    for (const rec of all) items.push({ key: rec.key, scriptId: rec.scriptId, voice: rec.voice, mime: rec.mime, createdAt: rec.createdAt, data: await blobToDataURL(rec.blob) });
    const payload = { app: "별밤책", version: 1, exportedAt: Date.now(), recordings: items };
    const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
    const res = await shareOrDownload(blob, "별밤책-백업.json", "별밤책 녹음 백업 파일이에요. 파일 앱이나 카톡(나에게)에 보관해 두세요.");
    if (res !== "cancel") toast(all.length + "개 녹음을 백업했어요 🛟"); track("backup");
  }
  async function restoreFromFile(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      if (!payload || !Array.isArray(payload.recordings)) { toast("별밤책 백업 파일이 아니에요"); return; }
      let n = 0;
      for (const it of payload.recordings) {
        const blob = await (await fetch(it.data)).blob();
        await dbPut({ key: it.key, scriptId: it.scriptId, voice: it.voice, blob, mime: it.mime || blob.type, createdAt: it.createdAt || Date.now() });
        n++;
      }
      state.saved = new Set(await dbAllKeys());
      toast(n + "개 녹음을 되살렸어요 🛟"); track("restore");
      if (homeEl.classList.contains("active")) renderHome();
      else if (storyEl.classList.contains("active")) refreshDock();
    } catch (e) { toast("복원에 실패했어요 (파일을 확인해 주세요)"); }
  }

  /* ================= 모달 (도움말·이름·백업·의견) ================= */
  function openModal(html) { modalBody.innerHTML = html; modalEl.hidden = false; }
  function closeModal() { modalEl.hidden = true; modalBody.innerHTML = ""; }

  function openHelp() {
    openModal(`
      <div class="modal-body">
        <h2>도움말 🌙</h2>
        <h3>📲 홈 화면에 추가하기 (앱처럼 쓰기)</h3>
        <ul>
          <li><b>아이폰</b>: 꼭 <b>사파리(Safari)</b>에서 → 아래 <b>공유(⬆️)</b> → <b>"홈 화면에 추가"</b></li>
          <li><b>안드로이드</b>: <b>크롬</b>에서 → <b>⋮ 메뉴</b> → <b>"홈 화면에 추가"</b></li>
        </ul>
        <p><b>카카오톡·인스타 등으로 링크를 열었다면</b>, 먼저 <b>사파리·크롬으로 열어주세요.</b><br/>
        (화면 <b>오른쪽 메뉴(⋯)</b> → <b>"다른 브라우저로 열기 / Safari로 열기"</b>)</p>
        <p class="hint">아이폰은 사파리에서만 "홈 화면에 추가"가 돼요. 그리고 녹음은 <b>연 브라우저마다 따로 저장</b>되니, 처음부터 사파리·크롬으로 여는 게 안전해요.</p>
        <h3>🎙️ 이렇게 써요</h3>
        <ul>
          <li>이야기 고르기 → 엄마/아빠 고르기 → <b>녹음하기</b></li>
          <li>대본 속 <b>(아기 이름)</b> 자리엔 우리 아기 이름을 넣어 읽어요</li>
          <li><b>저장</b> 후 <b>들려주기</b> 를 누르면 밤 화면과 함께 목소리가 흘러요</li>
        </ul>
        <h3>💾 녹음 보관 (중요)</h3>
        <p>녹음은 <b>이 기기 안에만</b> 저장돼요. 기기를 바꾸거나 브라우저 기록을 지우면 사라질 수 있어요.
        소중한 녹음은 <b>"녹음 백업"</b>으로 파일을 저장해 두세요.</p>
        <button class="modal-btn ghost" id="helpToBackup">🛟 녹음 백업 · 복원</button>
        <h3>💛 의견 보내기</h3>
        <p>쓰다가 불편한 점이나 바라는 게 있으면 알려주세요. 큰 힘이 돼요.</p>
        <button class="modal-btn" id="helpToFeedback">의견 보내기</button>
        <p class="hint" id="diagLine" style="margin-top:20px; text-align:center;"></p>
      </div>`);
    $("helpToBackup").addEventListener("click", openBackup);
    $("helpToFeedback").addEventListener("click", openFeedback);
    const diag = $("diagLine");
    if (diag) {
      const mode = isStandalone() ? "앱" : "브라우저";
      const vv = window.visualViewport ? Math.round(window.visualViewport.height) : "-";
      const homeH = Math.round((homeEl.getBoundingClientRect && homeEl.getBoundingClientRect().height) || 0);
      let sat = 0, sab = 0;
      try {
        const probe = document.createElement("div");
        probe.style.cssText = "position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
        document.body.appendChild(probe);
        const cs = getComputedStyle(probe); sat = parseInt(cs.paddingTop) || 0; sab = parseInt(cs.paddingBottom) || 0;
        probe.remove();
      } catch (e) {}
      diag.textContent = `별밤책 ${APP_VERSION} · ${mode} · win${window.innerHeight} vv${vv} scr${(window.screen && window.screen.height) || "-"} home${homeH} sat${sat} sab${sab}`;
    }
  }

  function openName() {
    const name = getBabyName();
    openModal(`
      <div class="modal-body">
        <h2>아기 이름 정하기 👶</h2>
        <p>이름을 넣으면 대본 속 <b>(아기 이름)</b> 자리가 우리 아기 이름으로 바뀌어요.
        예) "잘 자렴, <span class="namebox">(지우)야</span>"</p>
        <label class="field-label" for="nameInput">아기 이름</label>
        <input class="text-input" id="nameInput" type="text" maxlength="12" placeholder="예: 지우" value="${escapeHtml(name)}" />
        <p class="hint">※ 이름을 바꾼 뒤엔, 이미 한 녹음은 예전 이름으로 들려요. 새 이름으로 다시 녹음하는 걸 권해요.</p>
        <button class="modal-btn gold" id="nameSave">저장</button>
        ${name ? '<button class="modal-btn ghost" id="nameClear">이름 지우기</button>' : ""}
      </div>`);
    const input = $("nameInput"); input.focus();
    $("nameSave").addEventListener("click", () => {
      const v = input.value.trim();
      try { localStorage.setItem("babyName", v); } catch (e) {}
      updateNameChip();
      if (storyEl.classList.contains("active")) renderScriptBody();
      toast(v ? `"${v}" 이름을 넣었어요 💛` : "이름을 비웠어요"); track("set_name"); closeModal();
    });
    if (name) $("nameClear").addEventListener("click", () => { try { localStorage.removeItem("babyName"); } catch (e) {} updateNameChip(); if (storyEl.classList.contains("active")) renderScriptBody(); toast("이름을 지웠어요"); closeModal(); });
  }

  function openBackup() {
    openModal(`
      <div class="modal-body">
        <h2>녹음 백업 · 복원 🛟</h2>
        <p>녹음은 이 기기 안에만 있어요. <b>백업</b>하면 모든 녹음을 <b>파일 하나</b>로 묶어요.
        기기를 바꾸거나 실수로 지워져도, 그 파일로 <b>복원</b>하면 되살아나요.</p>
        <button class="modal-btn gold" id="doBackup">📦 모든 녹음 백업하기</button>
        <button class="modal-btn ghost" id="doRestore">📥 백업 파일에서 복원</button>
        <h3>어디에 저장하나요?</h3>
        <p>백업을 누르면 <b>저장할 곳을 고르는 창</b>이 떠요. <b>파일 앱 · 아이클라우드 · 카카오톡(나에게)</b> 등에 보관하세요.</p>
        <p class="hint">※ 백업은 사진·영상이 아니라 <b>데이터 파일</b>이라 <b>사진첩(앨범)</b>엔 저장되지 않아요. 복원할 땐 저장해 둔 그곳(파일 앱·카톡 등)에서 <b>별밤책-백업.json</b>을 고르면 돼요.</p>
      </div>`);
    $("doBackup").addEventListener("click", () => { backupAll(); });
    $("doRestore").addEventListener("click", () => restoreInput.click());
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
        <button class="modal-btn" id="iabOk">알겠어요</button>
      </div>`);
    const ok = document.getElementById("iabOk");
    if (ok) ok.addEventListener("click", closeModal);
  }

  function openFeedback() {
    openModal(`
      <div class="modal-body">
        <h2>의견 보내기 💛</h2>
        <p>불편한 점, 바라는 점, 응원 모두 좋아요. 만든 사람에게 전해져요.</p>
        <label class="field-label" for="fbMsg">내용</label>
        <textarea class="text-area" id="fbMsg" placeholder="자유롭게 적어주세요"></textarea>
        <label class="field-label" for="fbEmail">답장 받을 이메일 (선택)</label>
        <input class="text-input" id="fbEmail" type="email" placeholder="선택 사항이에요" />
        <button class="modal-btn" id="fbSend">보내기</button>
        <p class="hint">보낸 내용은 만든 사람에게만 전달돼요.</p>
      </div>`);
    $("fbSend").addEventListener("click", async () => {
      const msg = $("fbMsg").value.trim(); const email = $("fbEmail").value.trim();
      if (!msg) { toast("내용을 적어주세요"); return; }
      const btn = $("fbSend"); btn.disabled = true; btn.textContent = "보내는 중…";
      try {
        await fetch("/", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ "form-name": "feedback", message: msg, email: email, "bot-field": "" }).toString() });
        toast("보내주셔서 고마워요 💛"); track("feedback"); closeModal();
      } catch (e) { toast("전송에 실패했어요. 잠시 후 다시 시도해 주세요"); btn.disabled = false; btn.textContent = "보내기"; }
    });
  }

  /* ================= 정리 ================= */
  function stopEverything() {
    stopTimer(); stopPlayback(); stopPlayerAudio();
    if (state.recorder && state.recorder.state !== "inactive") { try { state.recorder.stop(); } catch (e) {} }
    releaseStream(); state.recorder = null; state.pending = null; state.mode = "idle";
  }

  /* ================= 이벤트 ================= */
  $("backBtn").addEventListener("click", showHome);
  $("helpBtn").addEventListener("click", openHelp);
  nameChip.addEventListener("click", openName);
  $("backupBtn").addEventListener("click", openBackup);
  $("modalClose").addEventListener("click", closeModal);
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) closeModal(); });
  document.querySelectorAll(".voice-tab").forEach((t) => t.addEventListener("click", () => selectVoice(t.dataset.voice)));
  importInput.addEventListener("change", (e) => { onImportFile(e.target.files[0]); e.target.value = ""; });
  restoreInput.addEventListener("change", (e) => { restoreFromFile(e.target.files[0]); e.target.value = ""; });
  $("playerClose").addEventListener("click", closePlayer);
  playPauseBtn.addEventListener("click", togglePlayPause);
  shuffleBtn.addEventListener("click", toggleShuffle);
  window.addEventListener("pagehide", stopEverything);

  /* ================= 시작 ================= */
  // 화면 높이 맞추기.
  // - 홈 화면 앱(설치본): 툴바가 없으므로 CSS 100dvh(전체화면)를 그대로 쓴다 → 여백 없음.
  // - 사파리 등 브라우저: 툴바 때문에 어긋나므로 실제 보이는 높이를 직접 재서 맞춘다.
  const isStandalone = () =>
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  function setAppHeight() {
    let h;
    if (isStandalone()) {
      // 설치본: iOS가 dvh/innerHeight를 상단 안전영역만큼 작게 줘서 하단에 여백이 생김
      // → 실제 화면 높이(screen.height)로 채운다. 안전영역은 padding으로 이미 처리됨.
      const scr = (window.screen && window.screen.height) || 0;
      const inner = window.innerHeight || 0;
      h = Math.max(scr, inner) || inner; // 더 큰 값(전체 화면)으로
    } else {
      h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
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
  try { player.shuffle = localStorage.getItem("autoNext") === "1"; } catch (e) {}
  updateShuffleBtn();
  renderHome();
  showIabNoticeIfNeeded();
})();
