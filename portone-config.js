/* 포트원(PortOne) V2 공개 설정 — 클라이언트에서 사용
   ⚠️ 여기에는 공개 식별자만 둔다. API Secret은 절대 넣지 않는다(서버 전용). */
var PORTONE_CONFIG = {
  storeId:    "store-153fb7b9-afb0-4876-90a9-9427c552330b",
  channelKey: "channel-key-8ceaf3c4-3ec1-4c8c-8483-2b14dcb8246e",
  /* 요금제 (구독정책 v1.0) — 금액은 KRW */
  plans: {
    monthly: { label: "월 구독", amount: 4900,  period: "month" },
    yearly:  { label: "연 구독", amount: 49000, period: "year"  }
  }
};
