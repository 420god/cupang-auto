/* ============================================================
   40-invoice.js — 구매대행(쿠플러스) 청구서 파서
   ------------------------------------------------------------
   **파일 순서가 곧 실행 순서다.** 원래 app.js 한 파일이던 것을 줄 단위로 자른 것이라
   전부 같은 전역 스코프를 공유한다(모듈 아님). 그래서 index.html의 <script> 순서를
   바꾸면 조용히 깨진다 — 이름 앞의 숫자가 그 순서다.
   자를 때 확인한 것: 로드 시점에 '아직 정의 안 된 것'을 참조하는 곳 0건.
   새 코드를 넣을 땐 최상위 실행문(이벤트 바인딩 등)이 **앞 파일의 것만** 참조하는지 볼 것.
   ============================================================ */
/* ===================== 구매대행 청구서 파서 =====================
   쿠플러스(㈜쿠패스) 구매대행 청구서 PDF의 텍스트를 줄 단위 구조로 되돌린다.
   구조와 함정은 docs/decisions.md 2026-08-18 "구매대행 청구서 PDF 구조" 참조.
   여기 다시 요약하는 이유는 이 함수가 그 함정들 위에 통째로 서 있기 때문이다:

   1) **한 줄 = SKU 1개**(옵션 단위). 같은 상품 다른 옵션도 각각 한 줄.
   2) **줄이 "1688 주문 묶음"으로 그룹지어져 있다.** 배송비·총금액은 묶음의 첫 줄에만
      찍히고 나머지 줄은 빈칸이다. → 숫자 개수로 그룹 머리/구성원을 판별한다:
        숫자 7개 = [수량, 협상전단가, 협상전배송비, 협상전총액, 협상후단가, 협상후배송비, 협상후총액]  → 그룹 머리
        숫자 3개 = [수량, 협상전단가, 협상후단가]                                                    → 그룹 구성원
   3) **줄별 KRW가 없다.** ₩ 붙은 3개 값(결제금액/부가세/최종합계)은 문서 전체 합계이고
      첫 줄에 한 번만 나온다. → 환율은 (전체 KRW ÷ 전체 CNY)로 역산한다.
   4) **협상후 단가는 총액에서 역산된 소수점 5자리**(1.04545 등)라 믿으면 안 된다.
      계산 기준은 언제나 그룹 총금액이고, 단가는 표시용이다.

   PDF→텍스트 변환기(pdf-parse 등)마다 줄바꿈 위치가 달라지므로 **줄 구조에 의존하지 않는다** —
   날짜 패턴으로 레코드를 자르고, 각 레코드에서 뒤쪽의 연속된 숫자 토큰만 뽑는다.
   상품명에 "3p" 같은 숫자+문자 토큰이 섞여도 순수 숫자만 세므로 안전하다. */

const PO_DATE_RE = /\d{4}-\d{2}-\d{2}/g;
const PO_PURE_NUM = /^\d+(\.\d+)?$/;

function parseCouplusInvoice(text) {
  const src = String(text || '').replace(/ /g, ' ');
  /* ── 줄 단위로 읽는 이유 ────────────────────────────────────────
     처음엔 날짜 위치로 텍스트를 잘랐는데, 병합된 칸(배송비·총금액)이 **자기만의 줄**로
     떨어져 나오는 청구서가 있었다(2026-06-26Z, 2026-08-18 발견):

       2026-06-26 growth 말차 샌드위치 슬랑이 6 13 13 NOBARCODE
       9 321 9 321                 <- 이 줄이 직전 상품의 숫자로 붙어버렸다
       2026-06-26 growth 청포도 샌드위치 슬랑이 6 13 13 NOBARCODE

     그래서 줄 단위로 보고, 날짜로 시작하지 않는 줄을 둘로 나눈다:
       (a) 직전 상품 줄이 아직 안 끝났으면 -> 줄바꿈으로 잘린 그 줄의 이어짐
       (b) 이미 끝났으면 -> 묶음의 배송비·총금액만 따로 그려진 줄
     "끝났는지"는 **바코드 칸(숫자가 아닌 토큰)이 나왔는지**로 판단한다.
     추출기에 따라 (a)로도 (b)로도 나오는 걸 실제로 겪어서 둘 다 처리한다. */
  const lines = src.split(/\r?\n/);
  const recs = [];
  const standalone = [];   // 묶음 값만 따로 그려진 줄. {afterRec, nums}
  let cur = null;
  let started = false;

  lines.forEach((raw) => {
    const line = raw.trim();
    if (!line) return;
    const dm = line.match(/^(\d{4}-\d{2}-\d{2})\b/);
    if (dm) {
      started = true;
      cur = {
        date: dm[1],
        toks: line.slice(dm[0].length).trim().split(/\s+/).filter(Boolean),
        closed: false
      };
      if (cur.toks.length && !PO_PURE_NUM.test(cur.toks[0])) cur.toks.shift();  // 업체명(growth)
      recs.push(cur);
    } else if (started && cur && !cur.closed) {
      cur.toks = cur.toks.concat(line.split(/\s+/).filter(Boolean));
    } else if (started) {
      standalone.push({
        afterRec: recs.length - 1,
        nums: line.split(/\s+/).filter((t) => PO_PURE_NUM.test(t)).map(Number)
      });
      return;
    } else {
      return;   // 첫 날짜 이전(계좌번호·표 머리글)은 통째로 무시 — 숫자가 섞여 있어 오인 위험
    }
    /* 바코드 칸(숫자가 아닌 토큰)이 나오면 그 상품 줄은 끝난 것으로 본다 */
    if (cur.toks.length && !PO_PURE_NUM.test(cur.toks[cur.toks.length - 1])) cur.closed = true;
  });

  if (!recs.length) return { rows: [], groups: [], totals: null, error: '청구서에서 날짜를 찾지 못했습니다.' };

  const rows = [];
  let totalKrw = null, vatKrw = null, grandKrw = null;

  recs.forEach((rec, recIdx) => {
    const mk = { date: rec.date, recIdx };
    const toks = rec.toks;

    /* 원화 토큰(₩12,345)은 문서 전체 합계 — 첫 레코드에만 나온다 */
    const krw = [];
    const rest = [];
    toks.forEach((t) => {
      if (/[₩₩]/.test(t)) krw.push(Number(t.replace(/[^\d.]/g, '')));
      else rest.push(t);
    });
    if (krw.length >= 3 && totalKrw === null) {
      totalKrw = krw[0]; vatKrw = krw[1]; grandKrw = krw[2];
    }

    /* 바코드 칸은 맨 끝이지만 **공백이 든 여러 토큰일 수 있다** — 실제로 바코드 대신
       "핑크 호빵 스퀴지" 같은 상품명이 적혀 온 청구서가 있었다(2026-07-02).
       그래서 토큰 하나가 아니라 뒤쪽의 "숫자가 아닌 토큰이 이어지는 구간" 전체를 뗀다.
       NOBARCODE면 없는 것으로 본다(샘플 화주수령 등 예외 케이스). */
    let barcode = null;
    let b = rest.length;
    while (b > 0 && !PO_PURE_NUM.test(rest[b - 1])) b--;
    if (b < rest.length) {
      const tail = rest.splice(b).join(' ');
      barcode = /^NOBARCODE$/i.test(tail) ? null : tail;
    } else if (rest.length && /^\d{8,}$/.test(rest[rest.length - 1])) {
      /* 숫자로만 된 바코드는 위 방법으로 안 잡힌다 — 8자리 이상 정수면 바코드로 본다
         (청구서의 수치 칸은 이만큼 커지지 않는다) */
      barcode = rest.pop();
    }

    /* 뒤에서부터 순수 숫자가 이어지는 구간이 수치 영역, 그 앞이 상품명 */
    let k = rest.length;
    while (k > 0 && PO_PURE_NUM.test(rest[k - 1])) k--;
    const nums = rest.slice(k).map(Number);
    const name = rest.slice(0, k).join(' ').trim();
    if (!name && !nums.length) return;

    rows.push({ date: mk.date, recIdx: mk.recIdx, name, barcode, nums });
  });

  /* ── 묶음 복원 ──────────────────────────────────────────────────
     처음엔 "총금액이 찍힌 줄이 묶음의 첫 줄"이라고 봤는데 **틀렸다**(2026-08-18).
     2026-07-02 청구서에서 총금액이 묶음 한가운데 줄에 찍혀 있었다:

       빨간구슬 21x7.5=157.5   <- 총금액 166.5 (=157.5+9)
       꿀빵     21x9  =189
       망고스틴 16x13 =208     <- 총금액 676.8 (묶음 한가운데!)
       딸기     16x15 =240
                        637 + 39.8 = 676.8

     PDF에서 세로로 병합된 칸이라 값이 어느 줄에 그려지는지가 일정하지 않다.
     위치에 의존하면 못 푼다. 그래서 **산수로 푼다**:

       묶음들은 줄 순서를 끊지 않고 이어지는 덩어리이고,
       각 묶음은  총금액 - 배송비 = 그 묶음 줄들의 (수량 x 단가) 합  을 만족한다.

     그래서 위에서부터 (수량 x 단가)를 누적하다가 다음 총금액과 맞아떨어지는 순간
     거기서 묶음을 끊는다. 위치와 무관하고, 맞으면 그 자체가 검산이 된다. */
  const markers = [];
  const out = rows.map((r) => {
    const n = r.nums;
    return {
      date: r.date, name: r.name, barcode: r.barcode,
      qty: n.length ? n[0] : 0,
      /* 협상후 단가: 7개면 5번째, 3개면 3번째. 협상전 값은 쓰지 않는다 */
      unitCny: n.length >= 7 ? n[4] : (n.length >= 3 ? n[2] : (n.length >= 2 ? n[1] : null)),
      groupIndex: -1, raw: n.slice()
    };
  });
  /* 배송비·총금액은 두 가지 방식으로 나온다 — 상품 줄 안에 섞여 있거나(숫자 7개),
     자기만의 줄로 떨어져 있거나. 둘을 **나온 순서 그대로** 한 줄로 세운다.
     아래 산수 방식은 순서만 맞으면 되고 어느 줄에 붙어 있었는지는 안 본다. */
  rows.forEach((r) => {
    if (r.nums.length >= 7) markers.push({ shippingCny: r.nums[5], totalCny: r.nums[6] });
    standalone.filter((s) => s.afterRec === r.recIdx).forEach((s) => {
      const n = s.nums;
      /* 협상전·협상후가 한 줄에 같이 오면(예: "12 174 8 170") 뒤쪽이 협상후다 */
      if (n.length >= 4) markers.push({ shippingCny: n[n.length - 2], totalCny: n[n.length - 1] });
      else if (n.length === 2) markers.push({ shippingCny: n[0], totalCny: n[1] });
    });
  });

  const r2 = (v) => Math.round(v * 100) / 100;
  const groups = [];
  let mi = 0, acc = 0, start = 0;
  out.forEach((l, i) => {
    acc = r2(acc + (l.qty || 0) * (l.unitCny || 0));
    if (mi < markers.length) {
      const target = r2(markers[mi].totalCny - markers[mi].shippingCny);
      if (Math.abs(acc - target) < 0.02) {
        groups.push({ shippingCny: markers[mi].shippingCny, totalCny: markers[mi].totalCny, lines: [] });
        for (let k = start; k <= i; k++) out[k].groupIndex = groups.length - 1;
        mi++; acc = 0; start = i + 1;
      }
    }
  });
  /* 어느 총금액과도 안 맞고 남은 줄들 — 인식이 깨졌거나 청구서 구조가 또 다른 경우다.
     조용히 버리지 않고 별도 묶음으로 남겨서 확인 화면의 검산 경고에 걸리게 한다. */
  if (start < out.length) {
    groups.push({ shippingCny: 0, totalCny: null, lines: [], leftover: true });
    for (let k = start; k < out.length; k++) out[k].groupIndex = groups.length - 1;
  }
  const unusedMarkers = markers.length - mi;
  out.forEach((l) => { if (groups[l.groupIndex]) groups[l.groupIndex].lines.push(l); });

  /* 묶음 배송비를 수량 비례로 배분 — 이 청구서 구조에서 유일하게 남은 배분 대상이다 */
  groups.forEach((g) => {
    const qtySum = g.lines.reduce((a, l) => a + (l.qty || 0), 0);
    g.lines.forEach((l) => {
      l.allocShipCny = qtySum > 0 ? (g.shippingCny || 0) * (l.qty / qtySum) : 0;
      l.lineCny = (l.qty || 0) * (l.unitCny || 0) + l.allocShipCny;
    });
    /* 검산: 우리가 계산한 합이 청구서의 묶음 총금액과 맞는가 */
    if (g.totalCny != null) {
      const calc = g.lines.reduce((a, l) => a + l.lineCny, 0);
      g.diffCny = Math.round((calc - g.totalCny) * 100) / 100;
    }
  });

  const sumCny = groups.reduce((a, g) => a + (g.totalCny != null
    ? g.totalCny
    : g.lines.reduce((b, l) => b + l.lineCny, 0)), 0);

  /* 환율은 문서에 안 적혀 있다 — 전체 KRW ÷ 전체 CNY로 역산한다.
     실측(2026-06-26 청구서): 2055.28 CNY, ₩657,690 → 320.0 */
  const rate = (totalKrw && sumCny) ? Math.round((totalKrw / sumCny) * 100) / 100 : null;

  return {
    rows: out, groups, unusedMarkers,
    totals: { totalKrw, vatKrw, grandKrw, sumCny, rate },
    date: out.length ? out[0].date : null,
    error: null
  };
}
