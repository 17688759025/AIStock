#!/usr/bin/env node
// Capture selection inputs during the 14:30 minute, then freeze one daily
// result. Later minute-series reads are always cut at 14:30, never at now.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRuntime } = require('./page-runtime.cjs');
const { makeRequest, mapLimit, writeOnce } = require('./collect_auction_result.cjs');

const ROOT = path.join(__dirname, '..');
const FIELDS = 'f2,f3,f6,f8,f10,f11,f12,f14,f17,f18,f22,f62,f100,f124,f184';
const FILTER = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048';
const TYPES = '8201,8202,8193,4,64,8207,8209,8211,8213,8215';
const instant = (date, time) => Date.parse(`${date}T${time}+08:00`);
const day = (now = new Date()) => new Date(+now + 8 * 3600000).toISOString().slice(0, 10);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function assertCloseCaptureTime(now, date) {
  if (!Number.isFinite(+now) || +now < instant(date, '14:30:00') || +now >= instant(date, '14:31:00')) {
    throw new Error('Missed the 14:30 capture minute; later quotes cannot replace the frozen result');
  }
}

async function eastmoney(request, endpoint, params) {
  let error;
  for (const host of ['push2.eastmoney.com', '82.push2.eastmoney.com', '20.push2.eastmoney.com']) {
    try {
      const j = await request(`https://${host}/api/qt/${endpoint}?${new URLSearchParams(params)}`, 3500);
      if (!j?.data?.diff) throw new Error('Empty Eastmoney response');
      return Object.values(j.data.diff);
    } catch (e) { error = e; }
  }
  throw error;
}

async function collectEvents(request, { debug = false } = {}) {
  const events = new Map(), pageSize = 500;
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ type: TYPES, pageindex: String(page), pagesize: String(pageSize), ut: '7eea3edcaed734bea9cbfc24409ed989', dpt: 'wzchanges' });
    const j = await request('https://push2ex.eastmoney.com/getAllStockChanges?' + params, 4000);
    const rows = j?.data?.allstock, total = Number(j?.data?.tc);
    if (!Array.isArray(rows) || !Number.isFinite(total) || total < 0) throw new Error('Invalid stock-change response');
    if (rows.some(e => !/^\d{6}$/.test(String(e.c)) || !Number.isFinite(Number(e.tm)))) throw new Error('Invalid stock-change record');
    for (const e of rows) {
      if (Number(e.tm) >= 140000 && Number(e.tm) <= 143000) events.set([e.c,e.tm,e.t,e.i].join('|'), e);
    }
    const reachedStart = rows.some(e => Number(e.tm) < 140000);
    const exhausted = page * pageSize + rows.length >= total;
    if (debug || reachedStart || exhausted) return { events: [...events.values()], pages: page + 1, complete: !debug, total };
    if (rows.length < pageSize) throw new Error('Stock-change pagination is incomplete');
  }
  throw new Error('Stock-change limit reached before covering 14:00–14:30');
}

function freshQuote(row, date, debug = false) {
  const stamp = Number(row.f124) * 1000;
  const validTime = debug ? Number.isFinite(stamp) && day(new Date(stamp)) === date : stamp >= instant(date, '14:30:00') && stamp < instant(date, '14:31:00');
  return validTime && typeof row.f3 === 'number' && Number(row.f2) > 0 && Number(row.f18) > 0;
}

async function collectCloseInputs(runtime, request, date, debug = false) {
  const specs = [['f62',1,'主力流入Top200'],['f62',2,'主力流入Top200'],['f22',1,'涨速Top100']];
  const jobs = specs.map(async ([fid,pn,label]) => {
    const rows = await eastmoney(request, 'clist/get', { pz:'100',pn:String(pn),po:'1',np:'1',fltt:'2',invt:'2',fid,fs:FILTER,fields:FIELDS });
    return { rows, label };
  });
  const results = await Promise.allSettled([...jobs, collectEvents(request, { debug })]);
  const rankingResults = results.slice(0,3).filter(r => r.status === 'fulfilled').map(r => r.value);
  const eventResult = results[3].status === 'fulfilled' ? results[3].value : null;
  // A truncated anomaly list would silently change grab scores. Treat it as
  // missing, record that in the snapshot, and never substitute a later list.
  const events = eventResult?.events || [];
  Object.assign(runtime.context, { frozenRankings: rankingResults, capturedEvents: events });
  const seeds = runtime.run(`mergeCandidates([
   ...frozenRankings.map(x=>normalize(x.rows).map(s=>({...s,signals:[x.label]}))),
   aggregateBullishEvents(capturedEvents,'close')
  ])`);
  if (seeds.length < 50) throw new Error('Insufficient 14:30 candidate sources');
  const batches = Array.from({ length: Math.ceil(seeds.length / 100) }, (_, i) => seeds.slice(i*100,(i+1)*100));
  const quoteRows = (await mapLimit(batches, 4, list => eastmoney(request, 'ulist.np/get', {
    fltt:'2',fields:FIELDS,secids:list.map(s=>(s.code.startsWith('6')?'1.':'0.')+s.code).join(','),
  }))).flat();
  const fresh = quoteRows.filter(q => freshQuote(q, date, debug));
  if (new Set(fresh.map(q=>String(q.f12))).size < seeds.length*.9) throw new Error('14:30 candidate quotes are incomplete or stale');
  runtime.context.closeQuoteRows = fresh;runtime.context.closeSeeds = seeds;
  const rows = runtime.run(`(()=>{const quotes=new Map(normalize(closeQuoteRows).map(s=>[s.code,s])),raw=new Map(closeQuoteRows.map(s=>[String(s.f12),s]));return closeSeeds.filter(s=>quotes.has(s.code)).map(s=>({...s,...quotes.get(s.code),
   anomalyScore:s.anomalyScore,bigBuyCount:s.bigBuyCount||0,bigBuyVolume:s.bigBuyVolume||0,
   quoteTime:Number(raw.get(s.code).f124)*1000,
   flowDataReady:Number.isFinite(raw.get(s.code).f62)&&Number.isFinite(raw.get(s.code).f184),
   signals:[...s.signals,...(${!eventResult}?['14:30异动接口缺失']:[])]
  }))})()`);
  return { rows, source: 'Eastmoney · 14:30资金与异动', events, coverage: {
    rankingPages:rankingResults.length, expectedRankingPages:3, eventComplete:!!eventResult?.complete,
    eventPages:eventResult?.pages||0, capturedEvents:events.length, capturedQuotes:rows.length,
  }};
}

async function buildCloseResult(runtime, inputs, meta) {
  Object.assign(runtime.context, { closeInputs: inputs, closeMeta: meta, closeMapLimit: mapLimit });
  return runtime.run(`(async()=>{
   mode='close';mainOnly=false;activeWindow=null;dataProvider=closeInputs.source;
   const base=closeInputs.rows.filter(s=>s.currentChange>-9.5&&!isNearLimit(s));
   const shortlist=list=>[...list].sort((a,b)=>closePreScore(b)-closePreScore(a)||a.code.localeCompare(b.code)).slice(0,120);
   const union=stableStocks([...shortlist(base),...shortlist(base.filter(isMainBoard))]);
   const done=await closeMapLimit(union,8,async s=>{try{return await loadWindow(structuredClone(s),'close')}catch(e){return null}});
   const ready=done.filter(Boolean),byCode=new Map(ready.map(s=>[s.code,s]));
   if(union.length&&!ready.length)throw Error('14:00–14:30 minute data unavailable; cannot freeze an empty result as a successful scan');
   const universes={};
   for(const scope of ['main','all']){
    mainOnly=scope==='main';const market=structuredClone(closeInputs.rows.filter(s=>!mainOnly||isMainBoard(s)));enrichMarket(market);
    const sectorByCode=new Map(market.map(s=>[s.code,s.sectorScore]));
    const selected=shortlist(base.filter(s=>!mainOnly||isMainBoard(s))),valid=selected.filter(s=>byCode.has(s.code)).map(s=>({...structuredClone(byCode.get(s.code)),sectorScore:sectorByCode.get(s.code)}));
    const candidates=valid.filter(s=>!isNearLimit(s)&&s.windowChange>-.8&&((s.mainFlow||0)>0||(s.bigBuyCount||0)>0));
    prepareCloseScores(candidates);const picks=rank(candidates).map(s=>({...s,frozenClose:true}));
    universes[scope]={scannedCount:market.length,shortlistedCount:selected.length,minuteReady:valid.length,candidateCount:candidates.length,candidates:structuredClone(candidates),picks};
   }
   return{schemaVersion:1,modelVersion:CLOSE_MODEL_VERSION,tradeDate:closeMeta.tradeDate,selectionTime:'14:30',windowStart:'14:00',windowEnd:'14:30',status:'final',debug:false,timezone:'Asia/Shanghai',...closeMeta,source:closeInputs.source,sourceCoverage:closeInputs.coverage,events:closeInputs.events,universes};
  })()`);
}

async function main() {
  const debug=process.argv.includes('--debug'),date=day();
  const output=debug?'/tmp/close-result-debug.json':path.join(ROOT,'data','close',`${date}.result.json`);
  if(!debug&&fs.existsSync(output)){console.log('Already frozen:',output);return;}
  if(!debug){
    const weekday=new Date(instant(date,'12:00:00')).getUTCDay();if(weekday===0||weekday===6){console.log('Weekend: no result');return;}
    if(Date.now()>=instant(date,'14:31:00'))throw Error('14:30 snapshot missed; no later reconstruction');
    while(Date.now()<instant(date,'14:30:03'))await sleep(Math.min(30000,instant(date,'14:30:03')-Date.now()));
  }
  const captureRequest=makeRequest(debug?Date.now()+60000:instant(date,'14:31:00'));
  const runtime=createRuntime({collectorDate:date});runtime.run('tradeDateKey=()=>collectorDate');
  const captureStartedAt=new Date().toISOString(),inputs=await collectCloseInputs(runtime,captureRequest,date,debug),captureCompletedAt=new Date().toISOString();
  if(!debug){assertCloseCaptureTime(new Date(captureStartedAt),date);assertCloseCaptureTime(new Date(captureCompletedAt),date);}
  const historyRequest=makeRequest(debug?Date.now()+240000:instant(date,'14:34:40'));
  runtime.context.closeRequest=historyRequest;
  runtime.context.fetch=async url=>({ok:true,json:async()=>historyRequest(url,5000)});
  runtime.run('requestNode=(url,timeout)=>closeRequest(url,timeout)');
  const result=await buildCloseResult(runtime,inputs,{tradeDate:date,captureStartedAt,captureCompletedAt});
  result.generatedAt=new Date().toISOString();result.debug=debug;result.snapshotId=crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
  if(!debug){
    if(Date.now()>=instant(date,'14:35:00'))throw Error('Missed result generation deadline');
    runtime.context.builtClose=result;runtime.run('validateFrozenClose(builtClose)');writeOnce(output,result);
  }else fs.writeFileSync(output,JSON.stringify(result));
  console.log(JSON.stringify({output,snapshotId:result.snapshotId,coverage:inputs.coverage,counts:Object.fromEntries(Object.entries(result.universes).map(([k,v])=>[k,{candidates:v.scannedCount,minuteReady:v.minuteReady,picks:v.picks.length}]))}));
}

module.exports={assertCloseCaptureTime,collectEvents,freshQuote,collectCloseInputs,buildCloseResult};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1});
