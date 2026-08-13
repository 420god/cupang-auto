/* Vercel 서버리스 함수 — 쿠팡 로켓그로스 Open API(주문 조회)를 서버에서만 서명·호출한다.
   secretKey는 여기(Vercel 환경변수)에만 존재하고 브라우저로 절대 전달하지 않는다.
   서명 규격: docs/api-notes.md "4. 로켓그로스 Open API" 참조 (developers.coupang.com 공식 문서 기준). */

const crypto = require('crypto');

const HOST = 'https://api-gateway.coupang.com';
const MAX_PAGES = 50; // nextToken 무한루프 방지용 안전장치

function signedDate() {
  const d = new Date(); // GMT 기준, yyMMdd'T'HHmmss'Z'
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
         `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function authHeader(method, path, query, accessKey, secretKey) {
  const datetime = signedDate();
  const message = datetime + method + path + query;
  const signature = crypto.createHmac('sha256', secretKey).update(message).digest('hex');
  return {
    datetime,
    header: `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${datetime}, signature=${signature}`
  };
}

function todayKst() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}${get('month')}${get('day')}`;
}

module.exports = async function handler(req, res) {
  const { COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY, COUPANG_VENDOR_ID } = process.env;
  if (!COUPANG_ACCESS_KEY || !COUPANG_SECRET_KEY || !COUPANG_VENDOR_ID) {
    res.status(500).json({
      error: 'Coupang Open API 환경변수가 설정되지 않았습니다 (COUPANG_ACCESS_KEY / COUPANG_SECRET_KEY / COUPANG_VENDOR_ID). Vercel 프로젝트 설정에서 등록 후 재배포하세요.'
    });
    return;
  }

  const date = todayKst();
  const path = `/v2/providers/rg_open_api/apis/api/v1/vendors/${COUPANG_VENDOR_ID}/rg/orders`;

  let nextToken = '';
  let orders = [];

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = `paidDateFrom=${date}&paidDateTo=${date}` +
        (nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : '');
      const { header } = authHeader('GET', path, query, COUPANG_ACCESS_KEY, COUPANG_SECRET_KEY);

      const upstream = await fetch(`${HOST}${path}?${query}`, {
        headers: { Authorization: header, 'Content-Type': 'application/json;charset=UTF-8' }
      });
      const body = await upstream.json().catch(() => null);

      if (!upstream.ok) {
        res.status(502).json({
          error: `쿠팡 API 오류 (HTTP ${upstream.status}): ${(body && (body.message || body.msg)) || '알 수 없는 오류'}`
        });
        return;
      }

      orders = orders.concat((body && body.data) || []);
      nextToken = (body && body.nextToken) || '';
      if (!nextToken) break;
    }
  } catch (e) {
    res.status(502).json({ error: `쿠팡 API 호출 실패: ${e.message}` });
    return;
  }

  const itemMap = {};
  let totalQuantity = 0;
  let totalRevenue = 0;

  orders.forEach((order) => {
    (order.orderItems || []).forEach((it) => {
      const qty = Number(it.salesQuantity) || 0;
      const unit = Number(it.unitSalesPrice) || 0;
      const revenue = qty * unit;
      totalQuantity += qty;
      totalRevenue += revenue;

      const key = String(it.vendorItemId);
      if (!itemMap[key]) {
        itemMap[key] = { vendorItemId: key, productName: it.productName || '', quantity: 0, revenue: 0 };
      }
      itemMap[key].quantity += qty;
      itemMap[key].revenue += revenue;
    });
  });

  res.status(200).json({
    date,
    totalQuantity,
    totalRevenue,
    orderCount: orders.length,
    items: Object.values(itemMap)
  });
};
