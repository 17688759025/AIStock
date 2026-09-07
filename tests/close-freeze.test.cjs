const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRuntime } = require('../scripts/page-runtime.cjs');
const { assertCloseCaptureTime, collectEvents, freshQuote, collectCloseInputs, buildCloseResult, updateCloseIndex } = require('../scripts/collect_close_result.cjs');
const DATE = '2026-09-07';
const ms = time => Date.parse(`${DATE}T${time}+08:00`);
const plain = value => JSON.parse(JSON.stringify(value));

function runtimeAt(time = '14:30:30', fetch = async () => { throw Error('offline'); }) {
  let clock = ms(time);
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const r = createRuntime({ Date: Clock, fetch });
  r.setTime = value => { clock = value.includes('T') ? Date.parse(value) : ms(value); };
  r.run("mode='close';loadCloseLiveChanges=async()=>[]");
  return r;
}
function fixture(r) {
  const pick = { code:'600001', name:'冻结测试', sector:'测试', currentChange:-1, score:82, adaptiveScore:82, mainFlow:1e8, flowRatio:3, bigBuyCount:2, windowChange:.8, windowEndChange:-1, windowVolume:2, trend:[10,10.01,10.02,10.05,10.08], sectorScore:55, turnover:1, speed:.5, signals:['大笔买入'], frozenClose:true };
  return { schemaVersion:1, modelVersion:r.run('CLOSE_MODEL_VERSION'), tradeDate:DATE, selectionTime:'14:30', status:'final', debug:false, snapshotId:'fixture-close', source:'测试快照', captureStartedAt:`${DATE}T14:30:03+08:00`, captureCompletedAt:`${DATE}T14:30:25+08:00`, universes:{
    main:{scannedCount:200,picks:[pick,{...pick,code:'600002',score:79}]},
    all:{scannedCount:300,picks:[{...pick,code:'300001',score:90}]},
  }};
}
function series() {
  return Array.from({length:241},(_,n)=>{const m=n<=120?n+570:n+660,close=100+n*.01;return{date:DATE,time:String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'),close,high:close,low:close,volume:100}});
}
const frozenFields = r => plain(r.run('stocks.map(({currentChange,...s})=>s)'));

test('14:30, 14:50 and after close preserve every factor and rank; only live percentage changes', async () => {
  const r=runtimeAt(),f=fixture(r),requests=[];
  r.context.fetch=async url=>{requests.push(url);return{ok:true,json:async()=>structuredClone(f)}};
  await r.run('refresh()');const before=frozenFields(r);
  // Crossing limit-up or turning negative later must not refilter a frozen pick.
  r.run('loadCloseLiveChanges=async picks=>picks.map((s,i)=>({code:s.code,change:i?-8:10,time:Date.now()}))');
  for(const time of ['14:50:00','15:10:00']){r.setTime(time);await r.run('refresh()');assert.deepEqual(frozenFields(r),before);}
  assert.equal(r.run('stocks[0].currentChange'),10);assert.equal(r.run('stocks[0].windowEndChange'),-1);
  assert.ok(requests.every(url=>url.includes(`data/close/${DATE}.result.json`)));
  const fresh=runtimeAt('14:50:00',async()=>({ok:true,json:async()=>structuredClone(f)}));await fresh.run('refresh()');assert.deepEqual(frozenFields(fresh),before);
  r.run('mainOnly=false');await r.run('refresh()');assert.equal(r.run('stocks[0].code'),'300001');
  r.run('mainOnly=true;loadCloseLiveChanges=async()=>[]');await r.run('refresh()');assert.equal(r.run('stocks[0].currentChange'),10);assert.deepEqual(frozenFields(r),before);
});

test('missing close snapshot never rescreens; official cache survives offline and expires next date', async () => {
  const r=runtimeAt('14:50:00');r.run('loadMarket=async()=>{throw Error("MUST NOT RESCREEN")};prepareCloseScores=()=>{throw Error("MUST NOT RESCORE")}');
  await r.run('refresh()');assert.equal(r.run('stocks.length'),0);assert.match(r.elements.get('dataNote').textContent,/缺少14:30/);
  r.context.fixture=fixture(r);r.run('localStorage.setItem(closeCacheKey(),JSON.stringify(fixture))');await r.run('refresh()');assert.equal(r.run('stocks.length'),2);
  assert.notEqual(r.run('closeCacheKey()'),r.run('frozenCacheKey()'));
  r.setTime('2026-09-08T14:50:00+08:00');await r.run('refresh()');assert.equal(r.run('stocks.length'),0);
});

test('pre-14:30 is unavailable; pending and valid zero-pick results have distinct messages', async () => {
  const r=runtimeAt('14:29:59');await r.run('refresh()');assert.match(r.elements.get('dataNote').textContent,/14:30后开放/);
  r.setTime('14:30:05');await r.run('refresh()');assert.match(r.elements.get('dataNote').textContent,/尚未发布/);
  const f=fixture(r);f.universes.main.picks=[];f.universes.all.picks=[];
  r.context.fetch=async()=>({ok:true,json:async()=>f});await r.run('refresh()');assert.equal(r.run('stocks.length'),0);assert.match(r.elements.get('dataNote').textContent,/当日无达标/);
});

test('invalid or late snapshots are rejected, including duplicate and unmarked picks', () => {
  const r=runtimeAt(),f=fixture(r);
  for(const patch of [{debug:true},{tradeDate:'2026-09-04'},{modelVersion:'old'},{selectionTime:'14:50'},{captureStartedAt:`${DATE}T14:29:59+08:00`},{captureCompletedAt:`${DATE}T14:31:00+08:00`},{captureCompletedAt:`${DATE}T14:30:00+08:00`}]){r.context.bad={...f,...patch};assert.throws(()=>r.run('validateFrozenClose(bad)'));}
  for(const picks of [[f.universes.main.picks[0],f.universes.main.picks[0]],[{...f.universes.main.picks[0],frozenClose:false}]]){r.context.bad={...f,universes:{...f.universes,main:{scannedCount:2,picks}}};assert.throws(()=>r.run('validateFrozenClose(bad)'));}
  assertCloseCaptureTime(new Date(ms('14:30:03')),DATE);
  for(const time of ['14:29:59','14:31:00','14:50:00'])assert.throws(()=>assertCloseCaptureTime(new Date(ms(time)),DATE));
});

test('close minute factors stop at 14:30 and do not overwrite the current quote', () => {
  const r=runtimeAt('14:50:00');r.context.points=series();
  let s=r.run("applyCloseWindow({currentChange:7,signals:[]},points,'close',100)");
  assert.equal(s.currentChange,7);assert.ok(Math.abs(s.windowEndChange-2.1)<1e-9);assert.ok(Math.abs(s.windowChange-(102.1/101.8-1)*100)<1e-9);
  s=r.run("applyCloseWindow({currentChange:-3,previousClose:100,signals:[]},points,'close',0)");assert.equal(s.currentChange,-3);assert.ok(Math.abs(s.windowEndChange-2.1)<1e-9);
  r.context.points=series().filter(p=>p.time!=='14:00');assert.throws(()=>r.run("applyCloseWindow({signals:[]},points,'close',100)"),/不足/);
  r.context.points=series().filter(p=>p.time!=='14:30');assert.throws(()=>r.run("applyCloseWindow({signals:[]},points,'close',100)"),/无数据/);
});

test('anomaly pagination covers more than 500 events, deduplicates, and excludes after 14:30:00', async () => {
  const event=(i,tm=142000)=>({c:String(600000+i),n:'测试',tm,t:8193,i:'100,10.0'});
  const first=Array.from({length:500},(_,i)=>event(i,i===0?143001:142500));
  const second=[first[1],event(501,143000),event(502,140000),event(503,135959)];let calls=0;
  const result=await collectEvents(async url=>{const p=Number(new URL(url).searchParams.get('pageindex'));calls++;return{data:{tc:900,allstock:p===0?first:second}}});
  assert.equal(calls,2);assert.equal(result.complete,true);assert.equal(result.events.length,501);assert.ok(result.events.every(e=>e.tm>=140000&&e.tm<=143000));
  const r=runtimeAt();r.context.events=result.events;const aggregated=r.run("aggregateBullishEvents(events,'close')");assert.equal(aggregated.length,501);assert.ok(aggregated.every(s=>s.bigBuyCount===1));
  await assert.rejects(()=>collectEvents(async()=>({data:{tc:1000,allstock:[event(0)]}})),/incomplete/);
});

test('fresh quotes must belong to the capture minute and have actual prices', () => {
  const row={f2:10,f3:1,f18:9,f124:ms('14:30:10')/1000};assert.equal(freshQuote(row,DATE),true);
  for(const patch of [{f124:ms('14:29:59')/1000},{f124:ms('14:31:00')/1000},{f3:'-'},{f2:0},{f18:0}])assert.equal(freshQuote({...row,...patch},DATE),false);
  assert.equal(freshQuote(row,'2026-09-08'),false);
});

test('input collector requotes source candidates inside capture minute and records missing anomalies', async () => {
  const r=runtimeAt(),rows=Array.from({length:50},(_,i)=>({f12:String(600000+i),f14:'测试'+i,f2:10,f18:10,f17:10,f3:-1,f6:1e8,f10:1,f8:1,f62:1e7,f184:3,f22:1,f124:ms('14:30:12')/1000}));
  const request=async url=>url.includes('getAllStockChanges')?{data:{tc:1000,allstock:[]}}:{data:{diff:rows}};
  const inputs=await collectCloseInputs(r,request,DATE);assert.equal(inputs.rows.length,50);assert.equal(inputs.coverage.rankingPages,3);assert.equal(inputs.coverage.eventComplete,false);
  assert.ok(inputs.rows.every(s=>s.mainFlow===1e7&&s.currentChange===-1&&s.snapshotPrice===10&&s.snapshotChange===-1&&s.quoteTime===ms('14:30:12')&&s.signals.includes('14:30异动接口缺失')));
  const stale=async url=>url.includes('getAllStockChanges')?{data:{tc:0,allstock:[]}}:{data:{diff:rows.map(s=>({...s,f124:ms('14:50:00')/1000}))}};
  await assert.rejects(()=>collectCloseInputs(r,stale,DATE),/stale/);
});

test('close result index is date sorted and stable when rebuilt', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aistock-close-index-')),dir=path.join(root,'data','close');fs.mkdirSync(dir,{recursive:true});
  try{
    fs.writeFileSync(path.join(dir,'2026-09-05.result.json'),JSON.stringify({generatedAt:'2026-09-05T06:31:00Z'}));
    fs.writeFileSync(path.join(dir,'2026-09-07.result.json'),JSON.stringify({generatedAt:'2026-09-07T06:31:00Z'}));
    const first=updateCloseIndex(root),content=fs.readFileSync(first.output,'utf8');assert.deepEqual(JSON.parse(content).dates,['2026-09-07','2026-09-05']);
    updateCloseIndex(root);assert.equal(fs.readFileSync(first.output,'utf8'),content);
  }finally{fs.rmSync(root,{recursive:true,force:true})}
});

test('collector uses unchanged close weights, freezes both scopes and permits green-price money inflows', async () => {
  const r=runtimeAt();r.context.points=series();r.run("loadWindow=async s=>applyCloseWindow(s,points,'close',100)");
  const inputs={source:'测试',events:[],coverage:{eventComplete:true},rows:Array.from({length:12},(_,i)=>({code:String(i<10?600000+i:300000+i),name:'模拟'+i,sector:'测试',currentChange:-1,amount:1e8,volume:1,turnover:1,mainFlow:1e7+i*1e6,flowRatio:i+1,speed:1,fiveMin:1,bigBuyCount:1,signals:[]}))};
  const meta={tradeDate:DATE,captureStartedAt:`${DATE}T14:30:03+08:00`,captureCompletedAt:`${DATE}T14:30:25+08:00`};
  const result=await buildCloseResult(r,inputs,meta);
  assert.deepEqual(plain(r.run('CLOSE_WEIGHTS')),{flow:32,flowRatio:13,grab:20,volume:15,trend:10,continuity:5,speed:2,sector:3});
  assert.equal(result.universes.main.scannedCount,10);assert.equal(result.universes.all.scannedCount,12);assert.equal(result.universes.main.picks.length,5);
  assert.ok(result.universes.main.picks.every(s=>s.frozenClose&&s.currentChange===-1&&s.mainFlow>0));
  r.context.result={...plain(result),snapshotId:'built-fixture'};assert.doesNotThrow(()=>r.run('validateFrozenClose(result)'));
  const empty=await buildCloseResult(r,{...inputs,rows:inputs.rows.map(s=>({...s,mainFlow:-1,bigBuyCount:0}))},meta);assert.equal(empty.universes.main.picks.length,0);
  r.run('loadWindow=async()=>{throw Error("minute API offline")}');await assert.rejects(()=>buildCloseResult(r,inputs,meta),/minute data unavailable/);
});
