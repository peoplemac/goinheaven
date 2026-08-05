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

      const charge = await portoneRequest(
        'POST',
        '/payments/' + encodeURIComponent(paymentId) + '/billing-key',
        secret,
        {
          storeId: PORTONE_STORE_ID,
          channelKey: PORTONE_CHANNEL_KEY,
          billingKey: billingKey,
          orderName: '사이버 추모관 ' + (plan === 'yearly' ? '연' : '월') + ' 구독 - ' + names,
          customer: { id: 'cust-' + gid, name: cust.name || '', phoneNumber: cust.phone || '', email: cust.email || '' },
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
        customerId: 'cust-' + gid,
        subscription: {
          plan: plan, status: 'active',
          startDate: _ymd(now), endDate: _ymd(end),
          lastPaymentAt: now.getTime(), amount: amount, autoRenew: true,
        },
      }, { merge: true });

      res.status(200).json({ success: true, plan: plan, amount: amount, endDate: _ymd(end) });
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
