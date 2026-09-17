/* 사이버 추모관 · 추모공원 PWA 서비스워커
   - 목적: '홈 화면에 추가(설치)' 가능 조건 충족용 최소 핸들러
   - 정책: 네트워크 우선(항상 최신 park.html). 오프라인일 때만 마지막 성공본으로 대체.
     Firebase/Storage/폰트 등 비내비게이션 요청은 가로채지 않고 브라우저 기본 처리. */
var CACHE = 'gih-park-v1';

self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { self.clients.claim(); });

self.addEventListener('fetch', function (event) {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).then(function (resp) {
        try {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put('./park.html', copy); });
        } catch (e) {}
        return resp;
      }).catch(function () {
        return caches.match('./park.html');
      })
    );
  }
});
