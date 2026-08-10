/* =========================================================
 * 별밤책 — 앱 로직
 * ---------------------------------------------------------
 * 이야기 하나 = 여러 "장면". 장면마다 엄마·아빠가 따로 녹음한다.
 * 아기에게 들려줄 땐 장면 클립을 순서대로 이어 재생하고, 그림도 함께 넘어간다.
 *
 * 저장(IndexedDB `voicebook` / store `recordings`, 서버 없음):
 *   - 장면 클립 : `${storyId}:v2:${voice}:${장면번호}`   ← 지금 방식
 *   - 예전 녹음 : `${storyId}:${voice}`                  ← 옛 버전(이야기 통째로 하나)
 *   두 가지가 한 창고에 같이 있고, 예전 녹음은 지우지 않는다.
 *   예전 녹음만 있는 이야기는 '예전 녹음'으로 그대로 들을 수 있다.
 *
 * 화면: 홈(이야기 고르기) · 녹음(부모용) · 들려주기(아기용)
 *   - 녹음으로 가는 길은 홈에만 있다(아기가 실수로 못 지우게).
 * ========================================================= */
(() => {
  "use strict";

  const VOICE_LABEL = { mom: "엄마", dad: "아빠" };
  const APP_VERSION = "v23";
  const STORE_VER = "v2";          // 장면 클립 키에 들어가는 방식 버전

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

  const homeEl = $("home"), recEl = $("rec"), playEl = $("play");
  const listEl = $("storyList"), footNote = $("footNote");
  const nameChip = $("nameChip"), nameOwner = $("nameOwner");
  const recTitleEl = $("recTitle"), recProgEl = $("recProg"), recBottomEl = $("recBottom");
  const recArtEl = $("recArt"), recTextEl = $("recText"), legacyNoteEl = $("legacyNote");
  const playStageEl = $("playStage"), playArtEl = $("playArt"), playTextEl = $("playText"), pauseOvEl = $("pauseOv");
  const modalEl = $("modal"), modalBody = $("modalBody");
  const restoreInput = $("restoreInput"), toastEl = $("toast");

  // 녹음 화면 상태
  const rec = {
    story: null, voice: "mom", scene: 0,
    done: new Set(),               // 이 이야기·이 목소리에서 녹음된 장면 번호
    hasLegacy: false,              // 예전(통) 녹음이 남아 있는지
    recorder: null, chunks: [], stream: null, recording: false,
    preview: null, previewOn: false,
  };
  // 들려주기 상태
  const pb = {
    story: null, voice: "mom", scene: 0, audio: null, url: null,
    state: "idle",                 // idle | playing | paused | ended
    mode: "scenes",                // scenes | legacy
    kinds: {},                     // { mom:"scenes"|"legacy"|null, dad:... }
  };

  const storyByIdx = (i) => STORIES[i];
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

  const sceneKey = (storyId, voice, i) => `${storyId}:${STORE_VER}:${voice}:${i}`;
  const legacyKey = (storyId, voice) => `${storyId}:${voice}`;

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
  // 이 이야기·이 목소리를 지금 들려줄 수 있나? "scenes"(장면 다 있음) | "legacy"(예전 녹음) | null
  function voiceKind(prog, story, v) {
    const p = prog[story.id];
    if (!p) return null;
    if (p[v].size >= sceneCount(story)) return "scenes";
    if (p[v + "Old"]) return "legacy";
    return null;
  }

  /* ================= 유틸 ================= */
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

  /* ================= 홈 화면 ================= */
  async function renderHome() {
    const prog = await loadProgress();
    let any = false;
    listEl.innerHTML = STORIES.map((s, i) => {
      const p = prog[s.id] || { mom: new Set(), dad: new Set(), momOld: false, dadOld: false };
      const N = sceneCount(s);
      const kinds = { mom: voiceKind(prog, s, "mom"), dad: voiceKind(prog, s, "dad") };
      if (p.mom.size || p.dad.size || p.momOld || p.dadOld) any = true;

      const pill = (icon, v) => {
        if (kinds[v] === "legacy") return `<span class="spill old">${icon} ${VOICE_LABEL[v]} · 예전 녹음</span>`;
        const c = p[v].size, cls = c === 0 ? "" : (c >= N ? "full" : "part");
        return `<span class="spill ${cls}">${icon} ${VOICE_LABEL[v]} ${c}/${N}</span>`;
      };
      const playable = kinds.mom || kinds.dad;
      const right = playable
        ? `<span class="sright"><button class="reBtn" data-idx="${i}" type="button" aria-label="녹음 고치기">🎙</button><span class="schev play">▶</span></span>`
        : `<span class="schev">❯</span>`;
      return `<li class="scard" data-idx="${i}" data-play="${playable ? "1" : ""}" tabindex="0" role="button">` +
        `<span class="scover" aria-hidden="true">${s.cover}</span>` +
        `<span class="sinfo"><span class="sname">${escapeHtml(s.title)}</span>` +
        `<span class="spills">${pill("👩", "mom")}${pill("👨", "dad")}</span></span>` +
        right + `</li>`;
    }).join("");

    // 줄 전체 = 들을 수 있으면 들려주기 / 아니면 녹음하기
    listEl.querySelectorAll(".scard").forEach((el) => {
      const open = () => { const i = +el.dataset.idx; if (el.dataset.play) openPlay(i, prog); else openRec(i, prog); };
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
    // 🎙 = 녹음 고치기 (아기 화면과 완전 분리 — 녹음 접근은 홈에서만)
    listEl.querySelectorAll(".reBtn").forEach((el) => {
      el.addEventListener("click", (e) => { e.stopPropagation(); openRec(+el.dataset.idx, prog); });
    });

    updateNameUI();
    updateFootNote(any);
  }
  async function showHome() {
    if (rec.recording) { toast("녹음을 먼저 멈춰 주세요"); return; }
    stopEverything();
    recEl.classList.remove("active"); playEl.classList.remove("active"); homeEl.classList.add("active");
    await renderHome();
  }

  /* ================= 녹음 화면 (부모용) ================= */
  async function openRec(i, prog) {
    stopEverything();
    rec.story = storyByIdx(i); rec.voice = "mom"; rec.scene = 0;
    recTitleEl.textContent = rec.story.title;
    document.querySelectorAll(".vtab").forEach((t) => t.classList.toggle("on", t.dataset.voice === "mom"));
    homeEl.classList.remove("active"); playEl.classList.remove("active"); recEl.classList.add("active");
    await loadRecState(prog);
    renderRec(true);
  }
  async function loadRecState(prog) {
    const p = (prog && prog[rec.story.id]) || (await loadProgress())[rec.story.id];
    rec.done = new Set(p ? p[rec.voice] : []);
    rec.hasLegacy = !!(p && p[rec.voice + "Old"]);
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
      legacyNoteEl.innerHTML = `예전에 통으로 녹음한 <b>${VOICE_LABEL[rec.voice]}</b> 목소리가 있어요. ` +
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
    html += rec.recording
      ? `<button class="main-btn" id="bStop" type="button">■ 멈춤</button>`
      : `<button class="main-btn" id="bRec" type="button">🔴 ${rec.done.has(rec.scene) ? "이 장면 다시 녹음" : "이 장면 녹음"}</button>`;
    recBottomEl.innerHTML = html;
    const bind = (id, fn) => { const b = $(id); if (b) b.addEventListener("click", fn); };
    bind("bPrev", () => goScene(rec.scene - 1));
    bind("bNext", () => goScene(rec.scene + 1));
    bind("bConfirm", togglePreview);
    bind("bRec", startRecording);
    bind("bStop", stopRecording);
  }
  function renderRec(anim) { paintRecScene(anim); renderRecTop(); renderRecBottom(); }

  async function setVoice(v) {
    if (v === rec.voice || rec.recording) return;
    stopPreview();
    rec.voice = v; rec.scene = 0;
    document.querySelectorAll(".vtab").forEach((t) => t.classList.toggle("on", t.dataset.voice === v));
    await loadRecState(null);
    renderRec(true);
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
    try { rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch (e) { toast("마이크 사용을 허용해 주세요 🎤"); return; }
    const mime = pickMime();
    try { rec.recorder = mime ? new MediaRecorder(rec.stream, { mimeType: mime }) : new MediaRecorder(rec.stream); }
    catch (e) { rec.recorder = new MediaRecorder(rec.stream); }
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
    try {
      await dbPut({ key: sceneKey(rec.story.id, rec.voice, rec.scene), storyId: rec.story.id, voice: rec.voice, scene: rec.scene, blob, mime, createdAt: Date.now() });
      rec.done.add(rec.scene); track("record_save");
    } catch (e) { toast("저장에 실패했어요 (저장 공간을 확인해 주세요)"); renderRec(false); return; }
    const N = sceneCount(rec.story);
    if (rec.done.size >= N) { toast("이 이야기를 다 녹음했어요 🎉  백업도 잊지 마세요!"); renderRec(true); return; }
    // 아직 안 한 장면으로 바로 이동 (팝업 없이 진행 표시만 갱신)
    for (let k = 1; k <= N; k++) { const i = (rec.scene + k) % N; if (!rec.done.has(i)) { rec.scene = i; break; } }
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

  /* ================= 들려주기 (아기용) =================
   * 장면 클립을 순서대로 자동 재생하며 그림도 함께 넘어간다.
   * 예전(통) 녹음뿐인 이야기는 그 파일을 통째로 들려준다(그림은 표지 하나).
   * 화면 탭 = 멈춤 / 이어보기. 여기엔 녹음으로 가는 길이 없다. */
  function openPlay(i, prog) {
    stopEverything();
    pb.story = storyByIdx(i);
    pb.kinds = { mom: voiceKind(prog, pb.story, "mom"), dad: voiceKind(prog, pb.story, "dad") };
    pb.voice = pb.kinds.mom ? "mom" : "dad";
    pb.mode = pb.kinds[pb.voice];
    pb.scene = 0;
    homeEl.classList.remove("active"); recEl.classList.remove("active"); playEl.classList.add("active");
    hidePauseOv();
    playCurrent(); track("play");
  }
  function paintPlayScene(anim) {
    if (pb.mode === "legacy") {
      playArtEl.textContent = pb.story.cover;
      playTextEl.innerHTML = `<span class="ln">${escapeHtml(pb.story.title)}</span>` +
        `<span class="ln" style="font-size:15px;opacity:.7">${VOICE_LABEL[pb.voice]} 목소리 · 예전 녹음</span>`;
    } else {
      const sc = pb.story.scenes[pb.scene];
      playArtEl.textContent = sc.emoji;
      playTextEl.innerHTML = sc.lines.map((l) => `<span class="ln">${renderName(l)}</span>`).join("");
    }
    if (anim) [playArtEl, playTextEl].forEach((el) => { el.classList.remove("scene-in"); void el.offsetWidth; el.classList.add("scene-in"); });
  }
  async function playCurrent() {
    hidePauseOv(); paintPlayScene(true); pb.state = "playing";
    let clip = null;
    const key = pb.mode === "legacy" ? legacyKey(pb.story.id, pb.voice) : sceneKey(pb.story.id, pb.voice, pb.scene);
    try { clip = await dbGet(key); } catch (e) {}
    if (pb.state !== "playing") return;             // 불러오는 사이에 멈췄으면 중단
    if (!clip) { pbAdvance(); return; }             // 혹시 빈 장면이면 건너뜀
    stopPlayAudio();
    pb.url = URL.createObjectURL(clip.blob);
    const a = new Audio(pb.url); pb.audio = a;
    a.addEventListener("ended", pbAdvance);
    a.addEventListener("error", pbAdvance);
    a.play().catch(() => { /* 자동재생이 막히면 조용히 둔다 (화면 탭으로 이어감) */ });
  }
  function pbAdvance() {
    if (pb.state !== "playing") return;
    if (pb.mode === "scenes" && pb.scene < sceneCount(pb.story) - 1) { pb.scene++; playCurrent(); }
    else pbEnd();
  }
  function pbPause() { if (pb.audio) { try { pb.audio.pause(); } catch (e) {} } pb.state = "paused"; showPauseOv("paused"); }
  function pbResume() { hidePauseOv(); pb.state = "playing"; if (pb.audio) pb.audio.play().catch(() => {}); else playCurrent(); }
  function pbRestart() { hidePauseOv(); stopPlayAudio(); pb.scene = 0; pb.state = "playing"; playCurrent(); }
  function pbEnd() { stopPlayAudio(); pb.state = "ended"; showPauseOv("ended"); }
  function pbSwitchVoice(v) {
    if (v === pb.voice || !pb.kinds[v]) return;
    pb.voice = v; pb.mode = pb.kinds[v]; pb.scene = 0;
    stopPlayAudio(); showPauseOv("paused");
  }
  function stopPlayAudio() {
    if (pb.audio) { try { pb.audio.pause(); } catch (e) {} pb.audio = null; }
    if (pb.url) { URL.revokeObjectURL(pb.url); pb.url = null; }
  }
  function stopPlayback() { stopPlayAudio(); pb.state = "idle"; hidePauseOv(); }

  function hidePauseOv() { pauseOvEl.hidden = true; pauseOvEl.innerHTML = ""; }
  function showPauseOv(kind) {
    const both = pb.kinds.mom && pb.kinds.dad;
    let html;
    if (kind === "paused") {
      html = `<div class="po-moon">🌙</div><div class="po-t">잠깐 멈췄어요</div>` +
        `<div class="po-s">화면을 다시 누르면 이어서 들려줘요</div>`;
      if (pb.mode === "legacy") html += `<div class="po-s">예전 녹음이에요. 장면마다 다시 녹음하면 그림이 함께 넘어가요.</div>`;
      if (both) html += `<div class="po-voices">` +
        `<button class="po-v ${pb.voice === "mom" ? "on" : ""}" type="button" data-v="mom">👩 엄마</button>` +
        `<button class="po-v ${pb.voice === "dad" ? "on" : ""}" type="button" data-v="dad">👨 아빠</button></div>`;
      html += `<div class="po-btns"><button class="po-b" type="button" data-a="home">🏠 목록으로</button>` +
        `<button class="po-b" type="button" data-a="restart">🔁 처음부터</button></div>`;
    } else {
      html = `<div class="po-moon">💤</div><div class="po-t">다 읽었어요</div>`;
      if (pb.mode === "legacy") html += `<div class="po-s">예전 녹음이에요. 장면마다 다시 녹음하면 그림이 함께 넘어가요.</div>`;
      html += `<div class="po-btns"><button class="po-b" type="button" data-a="home">🏠 목록으로</button>` +
        `<button class="po-b" type="button" data-a="restart">🔁 다시 들려주기</button></div>`;
    }
    pauseOvEl.innerHTML = html; pauseOvEl.hidden = false;
    pauseOvEl.querySelectorAll(".po-v").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); pbSwitchVoice(b.dataset.v); }));
    pauseOvEl.querySelectorAll(".po-b").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (b.dataset.a === "home") showHome(); else pbRestart();
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
  async function buildBackup() {
    backupReady = null; backupBuilding = true; updateBackupHint();
    try {
      const all = await dbAll();
      if (!all.length) { backupReady = { empty: true, count: 0 }; return; }
      const clips = [];
      for (const r of all) {
        if (!r || !r.key || !r.blob) continue;
        clips.push({ key: r.key, mime: r.mime || r.blob.type || "audio/webm", createdAt: r.createdAt || Date.now(), data: await blobToDataURL(r.blob) });
      }
      const payload = { app: "별밤책", kind: "scene-clips", version: 3, exportedAt: Date.now(), clips };
      const blob = new Blob([JSON.stringify(payload)], { type: "text/plain" });
      const file = new File([blob], "별밤책-백업.txt", { type: "text/plain" });
      backupReady = { file, blob, count: clips.length };
    } catch (e) { backupReady = null; }
    finally { backupBuilding = false; updateBackupHint(); }
  }
  function updateBackupHint() {
    const h = $("backupHint"); if (!h) return;
    if (backupBuilding || !backupReady) { h.textContent = "백업 파일을 준비하고 있어요…"; return; }
    if (backupReady.empty) { h.textContent = "아직 백업할 녹음이 없어요."; return; }
    h.innerHTML = "준비 완료 — <b>" + backupReady.count + "개</b> 녹음을 보낼 수 있어요.";
  }
  // 카톡/메일/드라이브 등으로 보내기. 공유창을 버튼 클릭 '즉시' 띄운다(중간 await 없음).
  async function sendBackup() {
    if (backupBuilding || !backupReady) { toast("백업을 준비하고 있어요. 잠깐 뒤 다시 눌러주세요"); return; }
    if (backupReady.empty) { toast("백업할 녹음이 없어요"); return; }
    const { file, blob, count } = backupReady;
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "별밤책 백업", text: "별밤책 녹음 백업 파일이에요. 카톡 '나에게'에 보관하면 폰을 바꿔도 안전해요." });
        markBackedUp();
        toast(count + "개 백업을 보냈어요 🛟  (카톡 ‘나에게’ 추천)"); track("backup"); return;
      }
    } catch (e) {
      if (e && e.name === "AbortError") return;   // 사용자가 취소
    }
    // 공유가 안 되는 환경(일부 설치본 등): 파일로 저장 시도 + 안내
    downloadBlob(blob, "별밤책-백업.txt");
    markBackedUp();
    toast("공유창이 안 떠서 파일로 저장했어요. 안 되면 사파리·크롬으로 열어 다시 해주세요");
  }
  async function restoreFromFile(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      // 지금 방식(clips) + 예전 방식(recordings) 백업 파일 둘 다 받는다
      const list = payload && (Array.isArray(payload.clips) ? payload.clips : (Array.isArray(payload.recordings) ? payload.recordings : null));
      if (!list) { toast("별밤책 백업 파일이 아니에요"); return; }
      let n = 0;
      for (const it of list) {
        if (!it || !it.key || !it.data) continue;
        const blob = await (await fetch(it.data)).blob();
        await dbPut({ key: it.key, blob, mime: it.mime || blob.type, createdAt: it.createdAt || Date.now() });
        n++;
      }
      toast(n + "개 녹음을 되살렸어요 🛟"); track("restore");
      if (homeEl.classList.contains("active")) await renderHome();
      else if (recEl.classList.contains("active")) { await loadRecState(null); renderRec(false); }
    } catch (e) { toast("복원에 실패했어요 (파일을 확인해 주세요)"); }
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
  function closeModal() { modalEl.hidden = true; modalBody.innerHTML = ""; }

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

        <h3 class="more-sec">🛟 녹음 백업 · 복원</h3>
        <p>녹음은 이 기기 안에만 있어요. <b>카카오톡 ‘나에게 보내기’</b>로 백업해 두면,
        폰을 바꾸거나 실수로 지워져도 카톡에서 다시 <b>복원</b>할 수 있어요.</p>
        <button class="modal-btn gold" id="doBackup" type="button">💬 카카오톡으로 백업 보내기</button>
        <p class="hint" id="backupHint">백업 파일을 준비하고 있어요…</p>
        <ol class="steps">
          <li>위 버튼을 누르면 <b>공유창</b>이 떠요</li>
          <li><b>카카오톡</b> 선택 → <b>나에게 보내기</b>(내 채팅방)에 저장</li>
        </ol>
        <p class="hint">💡 <b>엄마·아빠 팁:</b> 서로 백업 파일을 주고받아 복원하면 <b>두 목소리가 한 폰에 합쳐져요.</b></p>

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
        <p>홈에서 <b>아직 녹음 안 한 이야기</b>를 누르면 녹음 화면이 나와요.
        장면마다 <b>🔴</b> 를 눌러 읽고, 다 읽으면 <b>■ 멈춤</b>. <b>🔊 녹음 확인</b>으로 들어볼 수 있어요.
        엄마·아빠 목소리를 각각 담을 수 있어요.</p>
        <h3>🌙 들려주기</h3>
        <p>다 녹음한 이야기를 누르면 아기에게 <b>자동으로 넘어가며</b> 들려줘요. 목소리에 맞춰 그림도 함께 넘어가요.
        화면을 누르면 잠깐 멈추고, 다시 누르면 이어서 들려줘요.</p>
        <p class="hint">아기 화면에는 녹음으로 가는 길이 없어요(실수로 지울 일 없게). 다시 녹음은 <b>목록의 🎙 버튼</b>으로요.</p>
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
  $("recHome").addEventListener("click", showHome);
  $("modalClose").addEventListener("click", closeModal);
  modalEl.addEventListener("click", (e) => { if (e.target === modalEl) closeModal(); });
  document.querySelectorAll(".vtab").forEach((t) => t.addEventListener("click", () => setVoice(t.dataset.voice)));
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
  const isStandalone = () =>
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || "") ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS 포함
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
