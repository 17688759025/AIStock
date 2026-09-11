#!/usr/bin/env node
// One authoritative result per trading date. No quotes collected after 09:30
// may be relabelled as an auction snapshot. Scoring uses the page's own model.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRuntime } = require('./page-runtime.cjs');

const ROOT = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const day = (now = new Date()) => new Date(+now + 8 * 3600000).toISOString().slice(0, 10);
const instant = (date, time) => Date.parse(`${date}T${time}+08:00`);

function assertCaptureTime(now, date) {
  if (!Number.isFinite(+now) || +now < instant(date, '09:25:00') || +now >= instant(date, '09:30:00')) {
    throw new Error('Outside 09:25–09:30 auction-only window; refusing intraday reconstruction');
  }
}

async function mapLimit(items, limit, worker) {
  const result = new Array(items.length);
  let cursor = 0, failed;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      if (failed) return;
      const i = cursor++; if (i >= items.length) return;
      try { result[i] = await worker(items[i], i); } catch (e) { failed ||= e; return; }
    }
  }));
  // Drain in-flight requests before switching providers or retrying a round.
  if (failed) throw failed;
  return result;
}

async function captureWithRetry({ date, deadline, providers, now = Date.now, pause = sleep, report = () => {}, debug = false }) {
  let round = 0;
  while (now() < deadline) {
    round++;
    for (const [source, collect] of providers) {
      if (now() >= deadline) break;
      const start = now();
      try {
        const market = await collect(), end = now();
        if (!debug) { assertCaptureTime(start, date); assertCaptureTime(end, date); }
        report({ round, source, status: 'captured', rows: market.rows.length });
        return { market, captureStartedAt: new Date(start).toISOString(), captureCompletedAt: new Date(end).toISOString() };
      } catch (e) { report({ round, source, status: 'failed', error: e.message }); }
    }
    const remaining = deadline - now();
    if (remaining > 0) await pause(Math.min(remaining, 3000 * Math.min(round, 5)));
  }
  throw new Error('Auction capture window exhausted; no valid snapshot captured');
}

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validateCapture(input, date) {
  if (!input || input.schemaVersion !== 1 || input.kind !== 'auction-capture' || input.debug !== false || input.tradeDate !== date) throw new Error('Invalid saved auction capture');
  assertCaptureTime(Date.parse(input.captureStartedAt), date);
  assertCaptureTime(Date.parse(input.captureCompletedAt), date);
  if (Date.parse(input.captureCompletedAt) < Date.parse(input.captureStartedAt)) throw new Error('Invalid capture interval');
  const { checksum, ...body } = input;
  if (checksum !== digest(body)) throw new Error('Saved auction capture checksum mismatch');
  const rows = input.market?.rows;
  if (!Array.isArray(rows) || rows.length < 4500 || new Set(rows.map(s=>s.code)).size !== rows.length || rows.some(s=>!/^\d{6}$/.test(s.code))) throw new Error('Incomplete saved auction universe');
  return input;
}

function makeRequest(deadline) {
  return async function request(url, timeout = 5000, raw = false) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Collection deadline reached');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeout, remaining));
    try {
      const response = await fetch(url, { signal: controller.signal, headers: {
        'User-Agent': 'Mozilla/5.0',
        Referer: url.includes('sina') ? 'https://finance.sina.com.cn/' : 'https://quote.eastmoney.com/',
      }});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return raw ? await response.text() : await response.json();
    } finally { clearTimeout(timer); }
  };
}

async function verifySinaDate(request, date, debug = false) {
  const text = await request('https://hq.sinajs.cn/list=sh600000,sz000001', 4000, true);
  const lines = [...text.matchAll(/var hq_str_(sh600000|sz000001)="([^"]*)"/g)];
  if (lines.length !== 2) throw new Error('Sina quote timestamp unavailable');
  for (const [, , fields] of lines) {
    const p = fields.split(',');
    if (p[30] !== date) throw new Error('Sina returned a previous trading date');
    if (!debug) assertCaptureTime(new Date(`${p[30]}T${p[31]}+08:00`), date);
    if (!Number.isFinite(Date.parse(`${p[30]}T${p[31]}+08:00`))) throw new Error('Invalid Sina timestamp');
  }
}

async function collectSina(request, runtime, date, debug = false) {
  await verifySinaDate(request, date, debug);
  const root = 'https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/';
  const countUrl = root + 'Market_Center.getHQNodeStockCount?node=hs_a';
  const count = Number(await request(countUrl));
  if (!Number.isInteger(count) || count < 4500 || count > 12000) throw new Error('Invalid Sina universe count');
  const pages = Array.from({ length: Math.ceil(count / 80) }, (_, i) => i + 1);
  const chunks = await mapLimit(pages, 6, async page => {
    const url = root + 'Market_Center.getHQNodeData?' + new URLSearchParams({
      num: '80', sort: 'symbol', asc: '1', node: 'hs_a', symbol: '', page: String(page),
    });
    const rows = await request(url);
    if (!Array.isArray(rows) || rows.length !== Math.min(80, count - (page - 1) * 80)) throw new Error(`Incomplete Sina page ${page}`);
    return rows;
  });
  const rows = chunks.flat();
  if (new Set(rows.map(x => String(x.code))).size !== count || Number(await request(countUrl)) !== count) throw new Error('Sina universe changed during collection');
  if (rows.filter(r => Number(r.open) > 0 && Number(r.settlement) > 0 && Number(r.volume) > 0).length < 2000) throw new Error('Sina opening prices are not ready');
  await verifySinaDate(request, date, debug);
  runtime.context.rawQuotes = rows;
  return { rows: runtime.run('stableStocks(normalizeSina(rawQuotes))'), source: 'Sina全市场 · 09:25竞价' };
}

async function collectEastmoney(request, runtime, date, debug = false) {
  const query = new URLSearchParams({ pz: '100', po: '1', np: '1', fltt: '2', invt: '2', fid: 'f12',
    fs: 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048',
    fields: 'f6,f12,f14,f3,f8,f10,f17,f18,f100,f124',
  });
  // Do not mix delayed hosts into a time-specific auction snapshot.
  const hosts = ['push2.eastmoney.com', '82.push2.eastmoney.com', '20.push2.eastmoney.com'];
  let error;
  for (const host of hosts) {
    try {
      const getPage = pn => request(`https://${host}/api/qt/clist/get?${query}&pn=${pn}`);
      const first = await getPage(1), total = Number(first?.data?.total);
      if (!Number.isInteger(total) || total < 4500) throw new Error('Invalid Eastmoney universe count');
      const rest = await mapLimit(Array.from({ length: Math.ceil(total / 100) - 1 }, (_, i) => i + 2), 6, getPage);
      const pages = [first, ...rest];
      if (pages.some(p => Number(p?.data?.total) !== total || !p?.data?.diff)) throw new Error('Eastmoney universe changed');
      const rows = pages.flatMap(p => Object.values(p.data.diff));
      if (rows.length !== total || new Set(rows.map(r => String(r.f12))).size !== total) throw new Error('Incomplete Eastmoney market');
      const active = rows.filter(r => Number(r.f17) > 0 && Number(r.f6) > 0);
      if (active.length < 2000) throw new Error('No complete auction market');
      const fresh = active.filter(r => debug ? day(new Date(Number(r.f124) * 1000)) === date : Number(r.f124) * 1000 >= instant(date, '09:25:00') && Number(r.f124) * 1000 < instant(date, '09:30:00'));
      if (fresh.length / active.length < .95) throw new Error('Eastmoney auction timestamps are stale');
      runtime.context.rawQuotes = rows;
      return { rows: runtime.run('stableStocks(normalize(rawQuotes))'), source: 'Eastmoney全市场 · 09:25竞价' };
    } catch (e) { error = e; }
  }
  throw error;
}

async function loadPremarket(request, date) {
  const local = path.join(ROOT, 'data', 'premarket', `${date}.json`);
  const valid = p => p?.tradeDate === date && !p.debug && Array.isArray(p.candidates) && Date.parse(p.generatedAt) < instant(date, '09:25:00');
  try { const p = JSON.parse(fs.readFileSync(local, 'utf8')); if (valid(p)) return p; } catch {}
  try {
    const p = await request(`https://raw.githubusercontent.com/17688759025/AIStock/main/data/premarket/${date}.json?t=${Date.now()}`);
    if (valid(p)) return p;
  } catch {}
  return null;
}

async function buildResult(runtime, market, premarket, meta) {
  Object.assign(runtime.context, { seedMarket: market.rows, seedPremarket: premarket, seedMeta: meta });
  return runtime.run(`(async()=>{
   mode='auction';mainOnly=false;dataProvider=${JSON.stringify(market.source)};
   const eligible=seedMarket.filter(s=>s.auction>=.6&&s.auction<=8.5&&s.volume>0&&!isNearLimit(s));
   await enrichAuctionSectors(eligible);
   const shortlist=list=>[...list].sort((a,b)=>auctionBell(b.auction,2.757,2.2)-auctionBell(a.auction,2.757,2.2)||a.code.localeCompare(b.code)).slice(0,40);
   const union=stableStocks([...shortlist(eligible),...shortlist(eligible.filter(isMainBoard))]);
   await enrichAuctionHistory(union);
   const byCode=new Map(union.map(s=>[s.code,s])),universes={};
   loadPremarketPool=async()=>{if(!seedPremarket)throw Error('当日盘前候选缺失；单只观察结果冻结为空');return seedPremarket};
   for(const scope of ['main','all']){
    mainOnly=scope==='main';allStocks=structuredClone(seedMarket.filter(s=>!mainOnly||isMainBoard(s)).map(s=>({...s,...(byCode.get(s.code)||{})})));
    auctionBreadth=allStocks.filter(s=>s.auction>0).length/Math.max(1,allStocks.length)*100;
    const base=allStocks.filter(s=>s.auction>=.6&&s.auction<=8.5&&s.volume>0&&!isNearLimit(s));enrichMarket(base);
    stocks=shortlist(base);prepareAuctionScores(stocks);
    const candidates=structuredClone(stocks),picks=rank(stocks).map(s=>({...s,frozenAuction:true}));
    await preparePremarketObservation(allStocks);
    universes[scope]={scannedCount:allStocks.length,candidateCount:base.length,historyReady:stocks.filter(s=>s.historyReady).length,fundReady:stocks.filter(s=>s.fundFlowReady).length,candidates,picks,premarketPick:structuredClone(premarketPick),premarketState};
   }
   return{schemaVersion:2,modelVersion:AUCTION_MODEL_VERSION,tradeDate:seedMeta.tradeDate,auctionTime:'09:25',status:'final',debug:false,timezone:'Asia/Shanghai',...seedMeta,source:dataProvider,universes};
  })()`);
}

function writeOnce(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw new Error('A result for this date already exists; it will not be overwritten');
  // Exclusive creation also protects manual reruns in the same checkout.
  fs.writeFileSync(file, JSON.stringify(payload), { encoding: 'utf8', flag: 'wx' });
}

function record(event) {
  const file = '/tmp/auction-collector-diagnostics.jsonl';
  const entry = { at: new Date().toISOString(), ...event };
  console.log(JSON.stringify(entry));
  fs.appendFileSync(file, JSON.stringify(entry)+'\n');
}

async function main() {
  const debug = process.argv.includes('--debug'), captureOnly = process.argv.includes('--capture-only'), scoreOnly = process.argv.includes('--score-only');
  const date = day(), now = new Date();
  const output = debug ? '/tmp/auction-result-debug.json' : path.join(ROOT, 'data', 'auction', date+'.result.json');
  const inputFile = path.join(ROOT, 'data', 'auction', date+'.capture.json');
  if (captureOnly && scoreOnly || debug && (captureOnly || scoreOnly)) throw Error('Conflicting collector modes');
  if (!debug && fs.existsSync(output)) { record({ phase:'skip', reason:'Already frozen', output }); return; }
  const weekday = new Date(instant(date, '12:00:00')).getUTCDay();
  if (!debug && (weekday === 0 || weekday === 6)) { record({ phase:'skip', reason:'Weekend' }); return; }
  let input;
  if (!debug && fs.existsSync(inputFile)) {
    input = validateCapture(JSON.parse(fs.readFileSync(inputFile, 'utf8')), date);
    record({ phase:'resume', inputFile });
  } else {
    if (scoreOnly) throw Error('No saved capture; scoring cannot fetch replacement quotes');
    if (!debug && +now >= instant(date, '09:30:00')) throw Error('09:25 auction snapshot was missed; refusing to backfill from intraday quotes');
    if (!debug) while (Date.now() < instant(date, '09:25:03')) await sleep(Math.min(30000, instant(date, '09:25:03') - Date.now()));
    const deadline = debug ? Date.now()+240000 : instant(date, '09:29:40');
    const request = makeRequest(deadline), runtime = createRuntime();
    record({ phase:'capture', status:'starting' });
    const captured = await captureWithRetry({
      date, deadline, debug, report:e=>record({phase:'capture', ...e}),
      providers:[
        ['Sina', ()=>collectSina(request, runtime, date, debug)],
        ['Eastmoney', ()=>collectEastmoney(request, runtime, date, debug)],
      ],
    });
    // Persist the verified, unscored market BEFORE optional enrichment.
    input = { schemaVersion:1, kind:'auction-capture', tradeDate:date, debug, ...captured };
    input.checksum = digest(input);
    if (!debug) { validateCapture(input,date); writeOnce(inputFile,input); }
    record({ phase:'capture', status:'saved', inputFile:debug?null:inputFile });
  }
  if (captureOnly) return;
  record({ phase:'score', status:'starting' });
  const scoreDeadline = Date.now()+600000, request = makeRequest(scoreDeadline);
  const runtime = createRuntime({collectorRequest:request,collectorDate:date});
  runtime.run(`requestNode=(url,timeout)=>collectorRequest(url,timeout);fetchJson=requestNode;tradeDateKey=()=>collectorDate;`);
  const premarket = await loadPremarket(request,date);
  const result = await buildResult(runtime, structuredClone(input.market), premarket, {
    tradeDate:date, captureStartedAt:input.captureStartedAt, captureCompletedAt:input.captureCompletedAt,
    captureChecksum:input.checksum, scoringBasis:'saved-auction-capture',
  });
  result.generatedAt = new Date().toISOString(); result.debug = debug;
  result.snapshotId = digest(result);
  if (!debug) {
    // Publication may be late; only quote timestamps must precede 09:30.
    runtime.context.resultToValidate=result;runtime.run('validateFrozenAuction(resultToValidate)');
    writeOnce(output,result);
  } else fs.writeFileSync(output,JSON.stringify(result));
  record({phase:'score',status:'saved',output,snapshotId:result.snapshotId});
}

module.exports = { assertCaptureTime, buildResult, writeOnce, mapLimit, makeRequest, captureWithRetry, validateCapture, digest };
if (require.main === module) main().catch(e => { record({phase:'fatal',error:e.message});console.error(e);process.exitCode=1; });
