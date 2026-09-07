const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntime } = require('../scripts/page-runtime.cjs');
const { assertCaptureTime, buildResult, writeOnce } = require('../scripts/collect_auction_result.cjs');

function runtimeAt(time = '09:25:20', fetch) {
  let clock = Date.parse(`2026-09-07T${time}+08:00`);
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const r = createRuntime({ Date: Clock, ...(fetch ? { fetch } : {}) });
  r.setTime = value => { clock = Date.parse(value.includes('T') ? value : `2026-09-07T${value}+08:00`); };
  return r;
}
const plain = x => JSON.parse(JSON.stringify(x));
function points(from, through) {
  return Array.from({ length: through - from + 1 }, (_, i) => {
    const n = from + i, wall = n <= 120 ? n + 570 : n + 660;
    return { date: '2026-09-07', time: `${String(Math.floor(wall / 60)).padStart(2, '0')}:${String(wall % 60).padStart(2, '0')}`, close: 100 + n, high: 100 + n, low: 100 + n, volume: 100 };
  });
}
function frozenFixture(r) {
  const pick = { code: '000001', name: '测试一', sector: '银行', auction: 2, currentChange: 2, auctionReturn: 0, score: 80, adaptiveScore: 80, frozenAuction: true, meetsTarget: true, amount: 12345, volume: 2, turnover: .1, trend: [0,0,0,0,2], signals: [], sectorScore: 65 };
  const second = { ...pick, code: '600000', name: '测试二', score: 79 };
  return { schemaVersion: 2, modelVersion: r.run('AUCTION_MODEL_VERSION'), tradeDate: '2026-09-07', auctionTime: '09:25', status: 'final', debug: false, snapshotId: 'fixture-immutable', source: '测试快照', captureStartedAt: '2026-09-07T09:25:03+08:00', captureCompletedAt: '2026-09-07T09:25:15+08:00', universes: {
    main: { scannedCount: 3100, picks: [pick, second], premarketPick: { code: pick.code, name: pick.name, premarketScore: 65, finalEventScore: 70, auctionConfirmScore: 72, quote: pick }, premarketState: '冻结单只结果' },
    all: { scannedCount: 5500, picks: [second], premarketPick: null, premarketState: '无单只候选' },
  }};
}

test('Shanghai trading-minute windows across opening and lunch', () => {
  const r = runtimeAt();
  const cases = [
    ['09:31:00',1,'09:30–09:31'], ['09:35:00',5,'09:30–09:35'], ['09:59:00',29,'09:30–09:59'],
    ['10:00:00',30,'09:30–10:00'], ['11:30:00',30,'11:00–11:30'],
    ['11:34:00',30,'11:00–11:30'], ['12:59:00',30,'11:00–11:30'], ['13:00:00',30,'11:00–11:30'],
    ['13:05:00',30,'11:05–11:30 + 13:00–13:05'], ['13:30:00',30,'13:00–13:30'],
    ['15:00:00',30,'14:30–15:00'], ['15:34:00',30,'14:30–15:00'],
  ];
  r.run("mode='intraday'");
  for (const [time, duration, label] of cases) { r.setTime(time); const w = r.run('tradingWindow()'); assert.equal(w.duration,duration); assert.equal(w.label,label); assert.equal(r.run('allowed()'),true); }
  for (const time of ['09:25:00','09:30:00']) { r.setTime(time); assert.equal(r.run('allowed()'),false); }
  for (const time of ['11:34:00','12:59:00','15:34:00']) { r.setTime(time); assert.equal(r.run('tradingWindow().paused'),true); }
  r.setTime('2026-09-07T01:35:00Z'); assert.equal(r.run('hhmm()'),935);
});

test('09:35 uses exactly the opening five minutes and includes the last price', () => {
  const r=runtimeAt('09:35:00');r.context.series=points(1,240);
  const s=r.run("activeWindow=tradingWindow();applyWindow({openPrice:100,signals:[]},series,'intraday',100)");
  assert.ok(Math.abs(s.windowChange-5)<1e-9);assert.equal(s.windowMinutes,5);assert.equal(s.trend.at(-1),105);
});

test('13:00 and 13:05 join morning points and exclude lunch/future data', () => {
  const r=runtimeAt('13:00:00');r.context.series=points(0,240);
  let s=r.run("activeWindow=tradingWindow();applyWindow({signals:[]},series,'intraday',100)");
  assert.ok(Math.abs(s.windowChange-(220/190-1)*100)<1e-9);
  r.setTime('13:05:00');s=r.run("activeWindow=tradingWindow();applyWindow({signals:[]},series,'intraday',100)");
  assert.ok(Math.abs(s.windowChange-(225/195-1)*100)<1e-9);assert.equal(s.trend.at(-1),225);
  assert.equal(r.run('inTradingWindow(12*60)'),false);assert.equal(r.run('inTradingWindow(11*60+10)'),true);assert.equal(r.run('inTradingWindow(13*60+6)'),false);
  r.context.series=points(0,120);assert.throws(()=>r.run("applyWindow({signals:[]},series,'intraday',100)"),/不完整/);
  r.context.series=points(121,125);assert.throws(()=>r.run("applyWindow({signals:[]},series,'intraday',100)"),/不完整/);
});

test('11:34 lunch refresh uses today 11:00–11:30 and never previous-day data', () => {
  const r=runtimeAt('11:34:00');
  r.context.series=[...points(0,120).map(p=>({...p,date:'2026-09-04',close:999})),...points(0,120)];
  const s=r.run("activeWindow=tradingWindow();applyWindow({signals:[]},series,'intraday',100)");
  assert.equal(s.windowLabel,'11:00–11:30');assert.equal(s.windowMinutes,30);assert.equal(s.trend.at(-1),220);
  assert.equal(r.run('activeWindow.asOf'),690);assert.equal(r.run('inTradingWindow(11*60+30)'),true);assert.equal(r.run('inTradingWindow(13*60)'),false);
  r.context.series=points(0,120).map(p=>({...p,date:'2026-09-04'}));
  assert.throws(()=>r.run("applyWindow({signals:[]},series,'intraday',100)"),/不完整/);
});

test('missing intraday minutes are not replaced with previous-day points', () => {
  const r=runtimeAt('09:35:00');r.context.series=points(0,5).map(p=>({...p,date:'2026-09-04'}));
  assert.throws(()=>r.run("activeWindow=tradingWindow();applyWindow({signals:[]},series,'intraday',100)"),/不完整/);
});

test('13:00 is morning-only; 13:30 prefers an actual afternoon boundary quote', () => {
  const r=runtimeAt('13:00:00');r.context.series=[...points(0,240),{date:'2026-09-07',time:'13:00',close:400,high:400,low:400,volume:100}];
  let s=r.run("activeWindow=tradingWindow();applyWindow({signals:[]},series,'intraday',100)");assert.equal(s.trend.at(-1),220);
  assert.equal(r.run('inTradingWindow(780)'),false);
  r.setTime('13:30:00');s=r.run("activeWindow=tradingWindow();applyWindow({signals:[]},series,'intraday',100)");assert.equal(s.trend[0],400);
  r.setTime('09:35:00');s=r.run("activeWindow=tradingWindow();applyWindow({signals:[]},series,'intraday',100)");assert.equal(s.volumeBaselineReady,false);
});

test('close strategy retains its fixed 14:00–14:30 window', () => {
  const r=runtimeAt('14:55:00');r.context.series=points(0,240);
  const s=r.run("applyWindow({signals:[]},series,'close',100)");
  assert.ok(Math.abs(s.windowChange-(310/280-1)*100)<1e-9);
});

test('the same immutable result is used at 09:25, after 09:30, and in a fresh browser', async () => {
  const r=runtimeAt(),fixture=frozenFixture(r),requests=[];
  r.context.fixture=fixture;r.context.fetch=async url=>{requests.push(url);return{ok:true,json:async()=>structuredClone(fixture)}};
  r.run('loadAuctionLiveChanges=async picks=>picks.map((s,i)=>({code:s.code,change:i?9:-5,time:Date.now()}))');
  await r.run('refresh()');const initial=r.run('stocks.map(({currentChange,auctionReturn,...s})=>s)');
  for(const time of ['09:31:00','10:35:00','15:10:00']){r.setTime(time);await r.run('refresh()');assert.deepEqual(plain(r.run('stocks.map(({currentChange,auctionReturn,...s})=>s)')),plain(initial));}
  assert.equal(r.run('stocks[0].currentChange'),-5);assert.equal(r.run('premarketPick.quote.amount'),12345);
  assert.ok(requests.every(url=>url.includes('2026-09-07.result.json')));
  const other=runtimeAt('15:10:00',async()=>({ok:true,json:async()=>structuredClone(fixture)}));other.run('loadAuctionLiveChanges=async()=>[]');await other.run('refresh()');
  assert.deepEqual(plain(other.run('stocks.map(({currentChange,auctionReturn,...s})=>s)')),plain(initial));
  r.run('mainOnly=false');await r.run('refresh()');assert.equal(r.run('stocks[0].code'),'600000');
});

test('missing snapshot never triggers live rescreening; cache survives network failure and expires next day', async () => {
  const r=runtimeAt('10:00:00',async()=>{throw Error('offline')});
  r.run('loadMarket=async()=>{throw Error("MUST NOT RESCREEN")};loadAuctionLiveChanges=async()=>[]');
  await r.run('refresh()');assert.equal(r.run('stocks.length'),0);assert.match(r.elements.get('dataNote').textContent,/缺少09:25/);
  r.context.fixture=frozenFixture(r);r.run('localStorage.setItem(frozenCacheKey(),JSON.stringify(fixture))');await r.run('refresh()');assert.equal(r.run('stocks.length'),2);
  r.setTime('2026-09-08T10:00:00+08:00');await r.run('refresh()');assert.equal(r.run('stocks.length'),0);assert.equal(r.run('premarketPick'),null);
});

test('debug, wrong-day, pre-09:25 and post-09:30 snapshots are rejected', () => {
  const r=runtimeAt();const f=frozenFixture(r);
  for(const patch of [{debug:true},{tradeDate:'2026-09-04'},{captureStartedAt:'2026-09-07T09:24:50+08:00'},{captureCompletedAt:'2026-09-07T09:30:01+08:00'},{modelVersion:'old'}]) {r.context.bad={...f,...patch};assert.throws(()=>r.run('validateFrozenAuction(bad)'));}
  assert.throws(()=>assertCaptureTime(new Date('2026-09-07T09:30:00+08:00'),'2026-09-07'));
  assertCaptureTime(new Date('2026-09-07T09:25:05+08:00'),'2026-09-07');
});

test('collector freezes both scopes and event selection using the existing scoring code', async () => {
  const r=runtimeAt();r.run('enrichAuctionSectors=async list=>list;enrichAuctionHistory=async list=>list');
  const market={source:'fixture',rows:Array.from({length:50},(_,i)=>({code:String(600000+i),name:'模拟'+i,sector:'测试',auction:2.4+i*.012,currentChange:2.4+i*.012,volume:1,volumeUnit:'x',amount:100000+i*1000,turnover:.1,signals:[],trend:[0,0,0,0,2.5]}))};
  const pre={tradeDate:'2026-09-07',candidates:[{code:'600020',name:'事件票',premarketScore:90,events:[]}]};
  const result=await buildResult(r,market,pre,{tradeDate:'2026-09-07',captureStartedAt:'2026-09-07T09:25:03+08:00',captureCompletedAt:'2026-09-07T09:25:15+08:00'});
  assert.equal(result.universes.main.candidates.length,40);assert.equal(result.universes.main.picks.length,5);assert.equal(result.universes.main.premarketPick.code,'600020');
  assert.ok(result.universes.main.picks.every(s=>s.frozenAuction));
  r.context.built={...plain(result),snapshotId:'test'};assert.doesNotThrow(()=>r.run('validateFrozenAuction(built)'));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aistock-freeze-test-')),file=path.join(dir,'2026-09-07.result.json');
  try{writeOnce(file,result);assert.throws(()=>writeOnce(file,{...result,source:'replacement'}),/not be overwritten/);assert.equal(JSON.parse(fs.readFileSync(file)).source,result.source)}finally{fs.rmSync(dir,{recursive:true,force:true})}
});
