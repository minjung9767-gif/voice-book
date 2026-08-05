/*
 * 사용 통계 (무료 · 개인정보 걱정 적은 GoatCounter)
 * ------------------------------------------------------------
 * CODE 를 비우면 아무 것도 로드하지 않고, 아무 데이터도 나가지 않는다.
 * 수집하는 건 익명 숫자뿐 — 녹음한 목소리·대본은 절대 나가지 않는다.
 *
 * 새/재방문 구분: 이 기기가 '처음'인지 '다른 날 다시 왔는지'만 익명으로 보낸다.
 *   - 개인을 식별하지 않는다(누가 누군지 모름). "몇 명이 돌아왔나" 숫자만 본다.
 *   - 판단은 이 기기 안(localStorage)에서만 하고, 결과 신호만 보낸다.
 */
(function () {
  "use strict";
  var CODE = "voicebook"; // GoatCounter 코드 (voicebook.goatcounter.com)

  var ready = false;
  var queue = [];

  function flush() {
    if (!ready || !window.goatcounter || !window.goatcounter.count) return;
    while (queue.length) {
      var name = queue.shift();
      try { window.goatcounter.count({ path: name, title: name, event: true }); } catch (e) {}
    }
  }

  // 행동/신호 집계 (준비 전이면 큐에 담았다가 나중에 전송)
  window.track = function (name) { queue.push(name); flush(); };

  if (!CODE) { window.track = function () {}; return; }

  // 방문 자동 집계 + 준비되면 새/재방문 신호 전송
  var s = document.createElement("script");
  s.async = true;
  s.src = "//gc.zgo.at/count.js";
  s.setAttribute("data-goatcounter", "https://" + CODE + ".goatcounter.com/count");
  s.addEventListener("load", function () {
    ready = true;
    trackVisitorType();
    flush();
  });
  document.head.appendChild(s);

  function trackVisitorType() {
    try {
      var today = todayStr();
      var first = localStorage.getItem("firstSeen");
      var last = localStorage.getItem("lastSeenDay");
      if (!first) {
        localStorage.setItem("firstSeen", today);
        window.track("new_user");          // 처음 온 기기
      } else if (last && last !== today) {
        window.track("returning_user");    // 다른 날 다시 온 기기(단골)
      }
      localStorage.setItem("lastSeenDay", today);
    } catch (e) {}
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  }
})();
