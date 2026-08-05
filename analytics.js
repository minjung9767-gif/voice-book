/*
 * 사용 통계 (무료 · 개인정보 걱정 적은 GoatCounter)
 * ------------------------------------------------------------
 * 지금은 꺼져 있음. 무료 계정을 만들면 받는 "코드"를 아래 CODE 에 넣으면 켜진다.
 *   예) 가입 후 내 주소가  https://mybook.goatcounter.com  이면  →  CODE = "mybook"
 * 비워두면 아무 것도 로드하지 않고, 아무 데이터도 나가지 않는다.
 * (수집하는 건 익명 방문/행동 숫자뿐. 녹음한 목소리는 절대 나가지 않는다.)
 */
(function () {
  "use strict";
  var CODE = "voicebook"; // GoatCounter 코드 (voicebook.goatcounter.com)

  // 설정 전 기본값: 아무 것도 안 함
  window.track = function () {};

  if (!CODE) return;

  // 페이지 방문 자동 집계
  var endpoint = "https://" + CODE + ".goatcounter.com/count";
  var s = document.createElement("script");
  s.async = true;
  s.src = "//gc.zgo.at/count.js";
  s.setAttribute("data-goatcounter", endpoint);
  document.head.appendChild(s);

  // 특정 행동(녹음/재생 등) 집계
  window.track = function (name) {
    try {
      if (window.goatcounter && window.goatcounter.count) {
        window.goatcounter.count({ path: name, title: name, event: true });
      }
    } catch (e) {}
  };
})();
