'use strict';
const functions = require('firebase-functions');
const https = require('https');
const { URLSearchParams } = require('url');

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
