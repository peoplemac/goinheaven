'use strict';
const functions = require('firebase-functions');
const https = require('https');
const crypto = require('crypto');
const { URLSearchParams } = require('url');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();

/* ── 포트원(PortOne) V2 정기결제 ── */
/* API Secret은 Secret Manager 로만 주입 (firebase functions:secrets:set PORTONE_V2_SECRET) */
const PORTONE_STORE_ID = 'store-153fb7b9-afb0-4876-90a9-9427c552330b';
const PORTONE_CHANNEL_KEY = 'channel-key-77cdefc5-a807-4b21-ab16-2d0e2bc51881';
const PLAN_AMOUNT = { monthly: 4900, yearly: 49000 };

/* PortOne V2 REST 호출 (Authorization: PortOne {secret}) */
function portoneRequest(method, path, secret, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = https.request({
      hostname: 'api.portone.io', path, method,
      headers: {
        'Authorization': 'PortOne ' + secret,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data, 'utf8'),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(d); } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, raw: d });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: null, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}
function _addPeriod(plan) {
  const d = new Date();
  if (plan === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d;
}
function _ymd(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/* 서버용 SOLAPI 문자 발송 — 인증정보는 Firestore settings/solapi 에서 읽음.
   미설정 시 조용히 건너뜀(best-effort 알림). */
async function _solapiSend(phone, text) {
  const to = (phone || '').replace(/-/g, '');
  if (!to) return { skipped: true };
  let creds = null;
  try {
    const s = await admin.firestore().collection('settings').doc('solapi').get();
    if (s.exists) creds = s.data();
  } catch (e) { return { error: e.message }; }
  if (!creds || !creds.key || !creds.secret || !creds.sender) return { skipped: true };
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', creds.secret).update(date + salt).digest('hex');
  const auth = 'HMAC-SHA256 apiKey=' + creds.key + ', date=' + date + ', salt=' + salt + ', signature=' + signature;
  const body = JSON.stringify({ messages: [{ to: to, from: String(creds.sender).replace(/-/g, ''), text: text }] });
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.solapi.com', path: '/messages/v4/send-many/detail', method: 'POST',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body, 'utf8') },
    }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => { let p = null; try { p = JSON.parse(d); } catch (e) {} resolve({ status: r.statusCode, body: p }); }); });
    req.on('error', (e) => resolve({ error: e.message }));
    req.write(body); req.end();
  });
}

/* 최초 결제 + 구독 활성화 (클라이언트가 빌링키 발급 후 호출) */
exports.startSubscription = functions
  .region('asia-northeast3')
  .runWith({ secrets: ['PORTONE_V2_SECRET'] })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ success: false, message: 'Method not allowed' }); return; }

    const { gid, plan, billingKey, customer } = req.body || {};
    if (!gid || !plan || !billingKey || !PLAN_AMOUNT[plan]) {
      res.status(400).json({ success: false, message: '필수 항목 누락 또는 잘못된 플랜' }); return;
    }
    const secret = process.env.PORTONE_V2_SECRET;
    if (!secret) { res.status(500).json({ success: false, message: '서버 결제키(PORTONE_V2_SECRET) 미설정' }); return; }

    try {
      const db = admin.firestore();
      const gref = db.collection('groups').doc(gid);
      const gsnap = await gref.get();
      if (!gsnap.exists || gsnap.data().deleted) {
        res.status(404).json({ success: false, message: '추모관을 찾을 수 없습니다.' }); return;
      }
      const g = gsnap.data();
      const names = (g.members || []).map((m) => m.name).filter(Boolean).join(' · ') || '추모관';
      const amount = PLAN_AMOUNT[plan];
      const paymentId = 'pay-' + gid + '-' + Date.now();
      const cust = customer || {};
      const custId = 'cust' + gid.replace(/[^A-Za-z0-9]/g, ''); // Toss customerKey 허용문자만

      const charge = await portoneRequest(
        'POST',
        '/payments/' + encodeURIComponent(paymentId) + '/billing-key',
        secret,
        {
          storeId: PORTONE_STORE_ID,
          billingKey: billingKey,
          orderName: '사이버 추모관 ' + (plan === 'yearly' ? '연' : '월') + ' 구독 - ' + names,
          customer: { id: custId },
          amount: { total: amount },
          currency: 'KRW',
        }
      );

      const ok = charge.status >= 200 && charge.status < 300;
      await gref.collection('payments').doc(paymentId).set({
        paymentId: paymentId, plan: plan, amount: amount, at: Date.now(),
        status: ok ? 'PAID' : 'FAILED', portone: charge.body || charge.raw || null,
      });

      if (!ok) {
        const msg = (charge.body && charge.body.message) || ('결제 실패 (HTTP ' + charge.status + ')');
        res.status(200).json({ success: false, message: msg, detail: charge.body }); return;
      }

      const now = new Date();
      const end = _addPeriod(plan);
      await gref.set({
        billingKey: billingKey,
        customerId: custId,
        subscription: {
          plan: plan, status: 'active',
          startDate: _ymd(now), endDate: _ymd(end),
          lastPaymentAt: now.getTime(), amount: amount, autoRenew: true,
        },
      }, { merge: true });

      await _solapiSend(cust.phone, '[사이버 추모관] ' + names + ' 추모관 구독이 시작되었습니다. ' + amount + '원 결제 완료, 다음 결제일 ' + _ymd(end));
      res.status(200).json({ success: true, plan: plan, amount: amount, endDate: _ymd(end) });
    } catch (e) {
      res.status(500).json({ success: false, message: '오류: ' + e.message });
    }
  });

/* ── 정기 자동청구 (2단계) ── */
/* 결제 예정일(endDate) 도래분을 찾아 빌링키로 자동 청구. 실패 시 3일 간격 최대 3회 재시도 → 유예 */
/* 구독 1건 청구 + 상태 갱신 (스케줄러·테스트 공용) */
async function _chargeSubscriptionDoc(doc, secret) {
  const g = doc.data();
  const sub = g.subscription || {};
  if (!g.billingKey) return { charged: false, message: '빌링키 없음(먼저 카드 등록 필요)' };
  const plan = sub.plan === 'yearly' ? 'yearly' : 'monthly';
  const amount = PLAN_AMOUNT[plan];
  const gid = g.id || doc.id;
  const custId = 'cust' + gid.replace(/[^A-Za-z0-9]/g, '');
  const names = (g.members || []).map((m) => m.name).filter(Boolean).join(' · ') || '추모관';
  const paymentId = 'pay-' + gid + '-' + Date.now();

  const charge = await portoneRequest(
    'POST', '/payments/' + encodeURIComponent(paymentId) + '/billing-key', secret,
    {
      storeId: PORTONE_STORE_ID,
      billingKey: g.billingKey,
      orderName: '사이버 추모관 ' + (plan === 'yearly' ? '연' : '월') + ' 구독 - ' + names,
      customer: { id: custId },
      amount: { total: amount },
      currency: 'KRW',
    }
  );
  const ok = charge.status >= 200 && charge.status < 300;

  await doc.ref.collection('payments').doc(paymentId).set({
    paymentId: paymentId, plan: plan, amount: amount, at: Date.now(),
    kind: 'recurring', status: ok ? 'PAID' : 'FAILED',
    portone: charge.body || charge.raw || null,
  });

  if (ok) {
    const newEnd = _addPeriod(plan); // 오늘 기준 +1개월/1년
    await doc.ref.set({
      subscription: Object.assign({}, sub, {
        status: 'active', endDate: _ymd(newEnd),
        lastPaymentAt: Date.now(), retryCount: 0, nextAttemptDate: null,
      }),
    }, { merge: true });
    await _solapiSend((g.contact || {}).phone, '[사이버 추모관] ' + names + ' 추모관 구독료 ' + amount + '원이 결제되었습니다. 다음 결제일 ' + _ymd(newEnd));
    return { charged: true, plan: plan, amount: amount, endDate: _ymd(newEnd) };
  }
  const retry = (sub.retryCount || 0) + 1;
  if (retry >= 3) {
    await doc.ref.set({
      subscription: Object.assign({}, sub, { status: 'past_due', retryCount: retry, nextAttemptDate: null }),
    }, { merge: true });
  } else {
    const next = new Date(); next.setDate(next.getDate() + 3);
    await doc.ref.set({
      subscription: Object.assign({}, sub, { retryCount: retry, nextAttemptDate: _ymd(next) }),
    }, { merge: true });
  }
  await _solapiSend((g.contact || {}).phone, '[사이버 추모관] ' + names + ' 추모관 구독료 결제가 실패했습니다 (' + retry + '회). 등록된 카드를 확인해 주세요.');
  return { charged: false, retryCount: retry, message: (charge.body && charge.body.message) || ('결제 실패 HTTP ' + charge.status) };
}

async function _processDueSubscriptions() {
  const secret = process.env.PORTONE_V2_SECRET;
  if (!secret) return { error: 'PORTONE_V2_SECRET 미설정' };
  const db = admin.firestore();
  const todayStr = _ymd(new Date());
  let snap;
  try {
    snap = await db.collection('groups').where('subscription.autoRenew', '==', true).get();
  } catch (e) {
    return { error: 'query 실패: ' + e.message };
  }
  const out = { checked: 0, charged: 0, failed: 0, skipped: 0 };
  for (let i = 0; i < snap.docs.length; i++) {
    const doc = snap.docs[i];
    const g = doc.data();
    const sub = g.subscription || {};
    if (g.deleted || !g.billingKey) { out.skipped++; continue; }
    if (sub.status !== 'active' && sub.status !== 'past_due') { out.skipped++; continue; }
    if (sub.status === 'past_due' && (sub.retryCount || 0) >= 3) { out.skipped++; continue; } // 재시도 3회 소진
    const dueDate = sub.nextAttemptDate || sub.endDate;
    if (!dueDate || dueDate > todayStr) { out.skipped++; continue; } // 아직 결제일 전
    out.checked++;
    const r = await _chargeSubscriptionDoc(doc, secret);
    if (r.charged) out.charged++; else out.failed++;
  }
  return out;
}

/* ⚠️ 테스트 전용: 특정 gid 구독을 결제일 무시하고 즉시 청구. 운영 배포 전 삭제 권장. */
const TEST_TRIGGER_TOKEN = 'gih-test-a7f39c2e8b41';
exports.testChargeSubscription = functions
  .region('asia-northeast3')
  .runWith({ secrets: ['PORTONE_V2_SECRET'] })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    const gid = (req.query.gid || '').toString();
    const token = (req.query.token || '').toString();
    if (token !== TEST_TRIGGER_TOKEN) { res.status(403).json({ ok: false, message: 'token 불일치' }); return; }
    if (!gid) { res.status(400).json({ ok: false, message: 'gid 파라미터가 필요합니다.' }); return; }
    const secret = process.env.PORTONE_V2_SECRET;
    if (!secret) { res.status(500).json({ ok: false, message: 'PORTONE_V2_SECRET 미설정' }); return; }
    try {
      const doc = await admin.firestore().collection('groups').doc(gid).get();
      if (!doc.exists) { res.status(404).json({ ok: false, message: '추모관을 찾을 수 없습니다.' }); return; }
      const r = await _chargeSubscriptionDoc(doc, secret);
      res.status(200).json({ ok: true, gid: gid, result: r });
    } catch (e) {
      res.status(500).json({ ok: false, message: e.message });
    }
  });

/* 매일 03:05(KST) 자동 실행 */
exports.chargeDueSubscriptions = functions
  .region('asia-northeast3')
  .runWith({ secrets: ['PORTONE_V2_SECRET'] })
  .pubsub.schedule('5 3 * * *')
  .timeZone('Asia/Seoul')
  .onRun(async () => {
    const r = await _processDueSubscriptions();
    console.log('[chargeDueSubscriptions]', JSON.stringify(r));
    return null;
  });

/* ── 유지관리 (4단계): 갱신 사전고지 + 만료 처리 ── */
async function _runMaintenance() {
  const db = admin.firestore();
  const todayStr = _ymd(new Date());
  const in3 = new Date(); in3.setDate(in3.getDate() + 3); const in3Str = _ymd(in3);
  let snap;
  try { snap = await db.collection('groups').get(); } catch (e) { return { error: e.message }; }
  const out = { reminded: 0, expired: 0 };
  for (let i = 0; i < snap.docs.length; i++) {
    const doc = snap.docs[i];
    const g = doc.data();
    const sub = g.subscription || {};
    if (g.deleted || !sub.status) continue;
    const names = (g.members || []).map((m) => m.name).filter(Boolean).join(' · ') || '추모관';

    /* 갱신 사전고지: 활성 자동결제 & 결제일 3일 이내 & 이번 주기 미고지 */
    if (sub.status === 'active' && sub.autoRenew === true && !sub.canceledAt &&
        sub.endDate && sub.endDate >= todayStr && sub.endDate <= in3Str && sub.reminderSentFor !== sub.endDate) {
      await _solapiSend((g.contact || {}).phone, '[사이버 추모관] ' + names + ' 추모관 구독료 ' + (sub.amount || '') + '원이 ' + sub.endDate + '에 자동 결제될 예정입니다.');
      await doc.ref.set({ subscription: Object.assign({}, sub, { reminderSentFor: sub.endDate }) }, { merge: true });
      out.reminded++;
    }

    /* 만료 처리: 결제일 지남 & 갱신 안 함(해지) 또는 재시도 소진(past_due) */
    const exhausted = sub.status === 'past_due' && (sub.retryCount || 0) >= 3;
    if (sub.status !== 'expired' && sub.endDate && sub.endDate < todayStr && (sub.autoRenew !== true || exhausted)) {
      await doc.ref.set({ subscription: Object.assign({}, sub, { status: 'expired', expiredAt: Date.now() }) }, { merge: true });
      out.expired++;
    }
  }
  return out;
}

/* 매일 03:10(KST) — 청구 스케줄러(03:05) 이후 실행 */
exports.subscriptionMaintenance = functions
  .region('asia-northeast3')
  .pubsub.schedule('10 3 * * *')
  .timeZone('Asia/Seoul')
  .onRun(async () => {
    const r = await _runMaintenance();
    console.log('[subscriptionMaintenance]', JSON.stringify(r));
    return null;
  });

/* 구독 해지 (3단계) — 유가족 adminPw 또는 슈퍼관리자 superPw 인증 */
exports.cancelSubscription = functions
  .region('asia-northeast3')
  .runWith({ secrets: ['PORTONE_V2_SECRET'] })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') { res.status(405).json({ success: false, message: 'Method not allowed' }); return; }

    const { gid, adminPw, superPw } = req.body || {};
    if (!gid) { res.status(400).json({ success: false, message: 'gid가 필요합니다.' }); return; }
    try {
      const db = admin.firestore();
      const gref = db.collection('groups').doc(gid);
      const gsnap = await gref.get();
      if (!gsnap.exists) { res.status(404).json({ success: false, message: '추모관을 찾을 수 없습니다.' }); return; }
      const g = gsnap.data();

      let authed = false;
      if (adminPw && g.adminPw && adminPw === g.adminPw) authed = true;
      if (!authed && superPw) {
        const s = await db.collection('settings').doc('superAdmin').get();
        if (s.exists && s.data().pw === superPw) authed = true;
      }
      if (!authed) { res.status(403).json({ success: false, message: '비밀번호가 일치하지 않습니다.' }); return; }

      const sub = g.subscription || {};
      /* 포트원 빌링키 삭제 (더 이상 청구 불가) */
      const secret = process.env.PORTONE_V2_SECRET;
      if (g.billingKey && secret) {
        await portoneRequest('DELETE', '/billing-keys/' + encodeURIComponent(g.billingKey), secret, null);
      }
      /* 자동갱신 중단 + 해지 표시. 상태는 active 유지(다음 결제일까지 이용), 빌링키 제거 */
      await gref.set({
        billingKey: admin.firestore.FieldValue.delete(),
        subscription: Object.assign({}, sub, { autoRenew: false, canceledAt: Date.now() }),
      }, { merge: true });

      res.status(200).json({ success: true, endDate: sub.endDate || null });
    } catch (e) {
      res.status(500).json({ success: false, message: '오류: ' + e.message });
    }
  });

/* 알리고 바이트 계산 (한글 2byte, 영문 1byte) */
function getByteLen(str) {
  let b = 0;
  for (let i = 0; i < str.length; i++) b += str.charCodeAt(i) > 0x7f ? 2 : 1;
  return b;
}

/* 발신 서버 IP 확인용 엔드포인트 */
exports.checkOutboundIp = functions
  .region('asia-northeast3')
  .https.onRequest((req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    https.get('https://api.ipify.org?format=json', (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => {
        try { res.json(JSON.parse(d)); }
        catch (e) { res.json({ ip: d.trim() }); }
      });
    }).on('error', (e) => res.status(500).json({ error: e.message }));
  });

/* SOLAPI(구 쿨에스엠에스) 문자 발송 — HMAC 인증, IP 등록 불필요 */
exports.sendSolapiSms = functions
  .region('asia-northeast3')
  .https.onRequest((req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') {
      res.status(405).json({ success: false, message: 'Method not allowed' });
      return;
    }

    const { apiKey, apiSecret, sender, receivers, message } = req.body || {};
    if (!apiKey || !apiSecret || !sender || !receivers || !message) {
      res.status(400).json({ success: false, message: '필수 항목이 누락되었습니다.' });
      return;
    }

    const recvArr = Array.isArray(receivers) ? receivers : [receivers];
    const cleanSender = String(sender).replace(/-/g, '');
    const messages = recvArr.map((to) => ({
      to: String(to).replace(/-/g, ''),
      from: cleanSender,
      text: message,
    }));

    /* HMAC-SHA256 서명 (date + salt) */
    const date = new Date().toISOString();
    const salt = crypto.randomBytes(16).toString('hex');
    const signature = crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex');
    const authorization =
      `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;

    const postData = JSON.stringify({ messages });
    const options = {
      hostname: 'api.solapi.com',
      path: '/messages/v4/send-many/detail',
      method: 'POST',
      headers: {
        'Authorization': authorization,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData, 'utf8'),
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', (chunk) => { data += chunk; });
      apiRes.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) { /* keep raw */ }
        const httpOk = apiRes.statusCode >= 200 && apiRes.statusCode < 300;
        const failedList = (parsed && parsed.failedMessageList) || [];
        const cnt = (parsed && parsed.groupInfo && parsed.groupInfo.count) || {};
        const successCnt = (cnt.registeredSuccess != null)
          ? cnt.registeredSuccess
          : (httpOk ? Math.max(recvArr.length - failedList.length, 0) : 0);
        res.json({
          success: httpOk && failedList.length === 0,
          successCnt: successCnt,
          failCnt: failedList.length,
          message: (parsed && (parsed.errorMessage || parsed.statusMessage)) || '',
          httpStatus: apiRes.statusCode,
          raw: parsed || data,
        });
      });
    });
    apiReq.on('error', (err) => {
      res.status(500).json({ success: false, message: '네트워크 오류: ' + err.message });
    });
    apiReq.write(postData);
    apiReq.end();
  });

exports.sendAligoSms = functions
  .region('asia-northeast3')
  .https.onRequest((req, res) => {
    /* CORS */
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
    if (req.method !== 'POST') {
      res.status(405).json({ result_code: '-1', message: 'Method not allowed' });
      return;
    }

    const { apiKey, userId, sender, receivers, message } = req.body || {};

    if (!apiKey || !userId || !sender || !receivers || !message) {
      res.status(400).json({ result_code: '-1', message: '필수 항목이 누락되었습니다.' });
      return;
    }

    const receiverStr = Array.isArray(receivers) ? receivers.join(',') : String(receivers);
    const cleanSender = String(sender).replace(/-/g, '');

    /* 90바이트 초과 시 LMS */
    const msgType = getByteLen(message) > 90 ? 'LMS' : 'SMS';

    const params = new URLSearchParams({
      key: apiKey,
      user_id: userId,
      sender: cleanSender,
      receiver: receiverStr,
      msg: message,
      msg_type: msgType,
    });
    if (msgType === 'LMS') params.append('title', '[사이버 추모관]');

    const postData = params.toString();

    const options = {
      hostname: 'apis.aligo.in',
      path: '/send/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(postData, 'utf8'),
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', (chunk) => { data += chunk; });
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          res.json(parsed);
        } catch (e) {
          res.status(500).json({ result_code: '-1', message: '알리고 응답 파싱 오류', raw: data });
        }
      });
    });

    apiReq.on('error', (err) => {
      res.status(500).json({ result_code: '-1', message: '네트워크 오류: ' + err.message });
    });

    apiReq.write(postData);
    apiReq.end();
  });
