// 6C 调试脚本：复现 wiring 6C 检查的服务端链路，打印每步真实响应
const { setup } = require('/Users/jing/Desktop/some_code/account/ledger/tests/server-helpers');
const config = require('/Users/jing/Desktop/some_code/account/ledger/server/config');
const api = require('/Users/jing/Desktop/some_code/account/ledger/server/api');
const http = require('node:http');
const Domain = require('/Users/jing/Desktop/some_code/account/ledger/js/domain');

const ctx = setup('ledger-c6debug-');
Object.assign(ctx, {
  host: config.HOST, port: 18999, token: 'debug-token', repoRoot: '/Users/jing/Desktop/some_code/account/ledger',
  backupKeep: 30, backupMinIntervalMs: 60000, startedAt: new Date().toISOString(),
  marketDataFetcher: { fx: require('/Users/jing/Desktop/some_code/account/ledger/server/providers/fixture').getFxRates },
  logger: { info() {}, warn() {}, error() {} }
});
const server = http.createServer(api.createHandlerEntry(ctx));
server.listen(0, ctx.host, async () => {
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const today = Domain.localTodayISO();
  const ty = Number(today.slice(0, 4)), tm = Number(today.slice(5, 7));
  const monthEnd = today.slice(0, 8) + String(new Date(Date.UTC(ty, tm, 0)).getUTCDate()).padStart(2, '0');
  const quoteDates = Array.from(new Set([today, monthEnd]));
  const quoteRows = (ins, price, currency) => quoteDates.map((d) =>
    ({ instrumentId: ins, priceMinor: price, currency, priceDate: d, provider: 'manual', status: 'ok' }));

  async function call(method, path, body, token) {
    const res = await fetch(base + '/api/v1' + path, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'x-ledger-token': token } : {}),
      body: body == null ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }
  const TOKEN = 'debug-token';
  // 先制造「此前检查残留」：d5 资产 + 当月正式结账（wiring 里 C7.11 之后的真实状态）
  const d5 = Domain.emptyAssets();
  d5.assetAccounts = [
    { id: 'd5-acc-cash', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: 'D5' },
    { id: 'd5-acc-safe', name: '应急金', kind: 'deposit', pool: 'safety', institution: 'D5' }
  ];
  d5.assetUnits = [
    { id: 'd5-u-cny', accountId: 'd5-acc-cash', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' },
    { id: 'd5-u-safe', accountId: 'd5-acc-safe', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' }
  ];
  let r0 = await call('GET', '/state');
  const d5seed = Object.assign({}, r0.json, {
    accounts: [], categories: [], txns: [], settings: {}, assets: d5,
    riskAssessments: [], allocationTargets: [], approvedInstruments: [], recommendations: [],
    decisions: [], decisionEvents: [], decisionLinks: []
  });
  console.log('0 PUT d5 state:', (await call('PUT', '/state', { state: d5seed }, TOKEN)).status);
  const closedD5 = await call('POST', '/monthly-closes', { month: today.slice(0, 7) }, TOKEN);
  console.log('0b d5 close:', closedD5.status, closedD5.json.close && closedD5.json.close.status);

  const a = Domain.emptyAssets();
  a.assetAccounts = [
    { id: 'c6-acc-cash', name: '投资现金户', kind: 'deposit', pool: 'investable', institution: 'C6' },
    { id: 'c6-acc-broker', name: '券商户', kind: 'broker', pool: 'investable', institution: 'C6' },
    { id: 'c6-acc-safe', name: '应急金', kind: 'deposit', pool: 'safety', institution: 'C6' }
  ];
  a.assetUnits = [
    { id: 'c6-u-cny', accountId: 'c6-acc-cash', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' },
    { id: 'c6-u-safe', accountId: 'c6-acc-safe', currency: 'CNY', balanceMinor: 50000000, asOf: today, sourceType: 'manual' }
  ];
  a.instruments = [
    { id: 'c6-ins-bond', symbol: 'C6BND', exchange: 'NASDAQ', currency: 'USD', name: '债基', instrumentType: 'etf', assetClass: 'fixed_income', exposureMarket: 'US', classificationStatus: 'confirmed' },
    { id: 'c6-ins-voo', symbol: 'C6VOO', exchange: 'SSE', currency: 'CNY', name: '宽基A', instrumentType: 'etf', assetClass: 'broad_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' },
    { id: 'c6-ins-thm', symbol: 'C6THM', exchange: 'SSE', currency: 'CNY', name: '主题', instrumentType: 'fund', assetClass: 'theme_equity', exposureMarket: 'CN', classificationStatus: 'confirmed' }
  ];
  a.holdings = [
    { id: 'c6-h-bond', accountId: 'c6-acc-broker', instrumentId: 'c6-ins-bond', quantity: '5000', costMinor: 5000000, asOf: today },
    { id: 'c6-h-voo', accountId: 'c6-acc-broker', instrumentId: 'c6-ins-voo', quantity: '50000', costMinor: 5000000, asOf: today },
    { id: 'c6-h-thm', accountId: 'c6-acc-broker', instrumentId: 'c6-ins-thm', quantity: '70000', costMinor: 7000000, asOf: today }
  ];
  a.quotes = quoteRows('c6-ins-bond', 1000, 'USD').concat(quoteRows('c6-ins-voo', 100, 'CNY')).concat(quoteRows('c6-ins-thm', 100, 'CNY'));
  a.fxRates = quoteDates.map((d) => ({ base: 'USD', quote: 'CNY', rateDecimal: '7.0000', rateDate: d, provider: 'manual', status: 'ok' }));

  let r = await call('GET', '/state');
  const seeded = Object.assign({}, r.json, {
    accounts: [], categories: [], txns: [], settings: {}, assets: a,
    riskAssessments: [], allocationTargets: [], approvedInstruments: [], recommendations: [],
    decisions: [], decisionEvents: [], decisionLinks: []
  }); // 注意：不清 monthlyCloses —— 复现 wiring 里「上月已由 d5 结过当月」的残留
  console.log('1 PUT state:', (await call('PUT', '/state', { state: seeded }, TOKEN)).status);
  const closed = await call('POST', '/monthly-closes', { month: today.slice(0, 7) }, TOKEN);
  console.log('2 close:', closed.status, closed.json.close && closed.json.close.status);
  const CAP = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'capacity');
  const WIL = Domain.RISK_QUESTIONS.filter((q) => q.kind === 'willingness');
  const answers = [];
  CAP.forEach((q, i) => answers.push({ questionId: q.id, optionId: q.options.filter((o) => o.score === [1, 1, 1, 2, 2][i])[0].id }));
  WIL.forEach((q, i) => answers.push({ questionId: q.id, optionId: q.options.filter((o) => o.score === [2, 2, 1, 1][i])[0].id }));
  const assessed = await call('POST', '/risk-assessments', { answers, assessedAt: today, reason: 'initial' }, TOKEN);
  console.log('3 assess:', assessed.status);
  const tgt = await call('POST', '/targets', {}, TOKEN);
  console.log('4 target:', tgt.status, tgt.json.item && tgt.json.item.level);
  const mapped = await call('POST', '/approved-instruments', { assetClass: 'broad_equity', instrumentIds: ['c6-ins-voo'] }, TOKEN);
  console.log('5 map:', mapped.status);

  // 页面路径生成建议：listMonthlyCloses 的 formal[0] 作为 snapshotRef
  const closes = await call('GET', '/monthly-closes');
  const formal = (closes.json.items || []).filter((c) => c.status === 'formal' && c.snapshot);
  console.log('6 closes formal count:', formal.length, 'first month:', formal[0] && formal[0].month);
  const cur = await call('GET', '/targets/current');
  const rec = await call('POST', '/recommendations', {
    snapshotRef: { closeId: formal[0].id, snapshotId: formal[0].snapshot.id, payloadHash: formal[0].snapshot.payloadHash },
    assessmentRef: { id: cur.json.assessment.id, ruleVersion: cur.json.assessment.ruleVersion },
    targetVersion: cur.json.target.templateVersion,
    ruleVersion: cur.json.target.ruleVersion,
    newFundsMinor: 200000,
  }, TOKEN);
  console.log('7 recommendation:', rec.status, rec.json.status, rec.json.id);

  const dec = await call('POST', '/decisions', {
    recommendationId: rec.json.id, intent: 'accepted', note: '按建议分两笔执行',
  }, TOKEN);
  console.log('8 decision:', dec.status, JSON.stringify(dec.json).slice(0, 400));

  // 复现 wiring ⑦：行情过期 PUT
  const st2 = await call('GET', '/state');
  const ty2 = Number(today.slice(0, 4)), tm2 = Number(today.slice(5, 7));
  const staleD2 = new Date(Date.UTC(ty2, tm2 - 1, Number(today.slice(8, 10))));
  staleD2.setUTCDate(staleD2.getUTCDate() - 6);
  const staleDay2 = staleD2.toISOString().slice(0, 10);
  st2.json.assets.quotes = st2.json.assets.quotes.map((q) =>
    q.instrumentId === 'c6-ins-voo' ? Object.assign({}, q, { priceDate: staleDay2 }) : q);
  console.log('sample quote row:', JSON.stringify(st2.json.assets.quotes.find((q) => q.instrumentId === 'c6-ins-voo')));
  const put2 = await call('PUT', '/state', { state: st2.json }, TOKEN);
  console.log('9 stale PUT:', put2.status, JSON.stringify(put2.json).slice(0, 300));

  server.close(() => { ctx.close(); process.exit(0); });
});
