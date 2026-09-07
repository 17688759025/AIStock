#!/usr/bin/env node
// Settle each frozen 14:30 result against the high of the next market
// trading day. Derived evaluations are immutable and never alter selection.
const fs = require('node:fs');
const path = require('node:path');
const { makeRequest, mapLimit, writeOnce } = require('./collect_auction_result.cjs');

const ROOT = path.join(__dirname, '..');
const day = (now = new Date()) => new Date(+now + 8 * 3600000).toISOString().slice(0, 10);
const compact = date => String(date).replace(/-/g, '');
const nextCalendarDate = date => new Date(Date.parse(date + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
const secid = code => (String(code).startsWith('6') ? '1.' : '0.') + code;

function snapshotBasis(pick) {
  const change = Number.isFinite(pick.snapshotChange) ? pick.snapshotChange : Number(pick.currentChange);
  const exact = Number(pick.snapshotPrice), previous = Number(pick.previousClose);
  const price = exact > 0 ? exact : previous > 0 && Number.isFinite(change) ? previous * (1 + change / 100) : NaN;
  if (!(price > 0) || !Number.isFinite(change)) throw new Error(`Missing 14:30 price basis for ${pick.code}`);
  return { price, change };
}

function parseKlines(payload) {
  const rows = payload?.data?.klines;
  if (!Array.isArray(rows)) throw new Error('Invalid Eastmoney daily response');
  return rows.map(row => {
    const p = String(row).split(',');
    return { date:p[0], open:Number(p[1]), close:Number(p[2]), high:Number(p[3]), low:Number(p[4]) };
  }).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.open > 0 && x.close > 0 && x.high > 0 && x.low > 0);
}

function parseTencentKlines(payload, key) {
  const rows=payload?.data?.[key]?.day||payload?.data?.[key]?.qfqday;
  if(!Array.isArray(rows))throw new Error('Invalid Tencent daily response');
  return rows.map(p=>({date:String(p[0]),open:Number(p[1]),close:Number(p[2]),high:Number(p[3]),low:Number(p[4])}))
    .filter(x=>/^\d{4}-\d{2}-\d{2}$/.test(x.date)&&x.open>0&&x.close>0&&x.high>0&&x.low>0);
}

async function loadKlines(request, id, begin, end) {
  const params = new URLSearchParams({ secid:id, klt:'101', fqt:'0', beg:compact(begin), end:compact(end),
    fields1:'f1,f2,f3,f4,f5,f6', fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61' });
  let error;
  for (const host of ['push2his.eastmoney.com','7.push2his.eastmoney.com','33.push2his.eastmoney.com']) {
    try { return parseKlines(await request(`https://${host}/api/qt/stock/kline/get?${params}`, 6500)); }
    catch (e) { error = e; }
  }
  throw error;
}

async function loadDailyBars(request, code, begin, end, index = false) {
  try { return (await loadKlines(request,index?'1.000001':secid(code),begin,end)).map(x=>({...x,provider:'Eastmoney'})); }
  catch (eastmoneyError) {
    const key=index?'sh000001':(/^[89]/.test(String(code))?'bj':String(code).startsWith('6')?'sh':'sz')+code;
    const param=[key,'day',begin,end,'320','none'].join(','),payload=await request('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param='+encodeURIComponent(param),6500);
    return parseTencentKlines(payload,key).map(x=>({...x,provider:'Tencent'}));
  }
}

async function buildEvaluation(snapshot, nextTradingDate, lookup, evaluatedAt = new Date().toISOString()) {
  if (!snapshot || snapshot.tradeDate >= nextTradingDate || snapshot.status !== 'final' || snapshot.debug || !snapshot.snapshotId) throw new Error('Invalid frozen close snapshot');
  const codes = [...new Set(['main','all'].flatMap(scope => (snapshot.universes?.[scope]?.picks || []).map(p => String(p.code))))];
  const bars = new Map(await mapLimit(codes, 5, async code => [code, await lookup(code, nextTradingDate)]));
  const universes = {};
  for (const scope of ['main','all']) {
    const source = snapshot.universes?.[scope];
    if (!source || !Array.isArray(source.picks)) throw new Error(`Missing ${scope} frozen picks`);
    const picks = source.picks.map((pick, index) => {
      const basis = snapshotBasis(pick), bar = bars.get(String(pick.code));
      if (bar && bar.date !== nextTradingDate) throw new Error(`Wrong next-day bar for ${pick.code}`);
      return { rank:index+1, code:String(pick.code), name:pick.name, sector:pick.sector, score:pick.score,
        snapshotChange:basis.change, snapshotPrice:basis.price, nextTradingDate,
        nextHigh:bar?.high ?? null, nextHighReturn:bar ? (bar.high / basis.price - 1) * 100 : null, priceProvider:bar?.provider ?? null,
        nextOpen:bar?.open ?? null, nextClose:bar?.close ?? null, suspendedOrMissing:!bar };
    });
    universes[scope] = { picks, evaluatedCount:picks.filter(p=>Number.isFinite(p.nextHighReturn)).length,
      positiveCount:picks.filter(p=>Number.isFinite(p.nextHighReturn)&&p.nextHighReturn>0).length };
  }
  return { schemaVersion:1, tradeDate:snapshot.tradeDate, selectionTime:'14:30', nextTradingDate,
    sourceSnapshotId:snapshot.snapshotId, evaluatedAt, metric:'nextHighReturn=(nextTradingDayHigh/14:30SnapshotPrice-1)*100',
    source:'Eastmoney daily K-line; Tencent daily K-line fallback', universes };
}

function updateHistoryIndex(root = ROOT) {
  const dir = path.join(root, 'data', 'close-history');fs.mkdirSync(dir,{recursive:true});
  const dates = fs.readdirSync(dir).map(name=>name.match(/^(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter(Boolean).sort().reverse();
  let updatedAt = null;
  for (const date of dates) { try { const x=JSON.parse(fs.readFileSync(path.join(dir,date+'.json'),'utf8'));if(x.evaluatedAt&&(!updatedAt||x.evaluatedAt>updatedAt))updatedAt=x.evaluatedAt; } catch {} }
  const output=path.join(dir,'index.json'),content=JSON.stringify({schemaVersion:1,updatedAt,dates},null,2)+'\n';
  if(!fs.existsSync(output)||fs.readFileSync(output,'utf8')!==content)fs.writeFileSync(output,content);
  return {output,dates};
}

async function main() {
  const today=day(),minutes=new Date(Date.now()+8*3600000).getUTCHours()*60+new Date(Date.now()+8*3600000).getUTCMinutes();
  if(minutes<905)throw new Error('Next-day high is not final before 15:05 Shanghai time');
  const closeDir=path.join(ROOT,'data','close');if(!fs.existsSync(closeDir)){console.log('No frozen close results yet');return;}
  const dates=fs.readdirSync(closeDir).map(n=>n.match(/^(\d{4}-\d{2}-\d{2})\.result\.json$/)?.[1]).filter(d=>d&&d<today).sort();
  const request=makeRequest(Date.now()+5*60000);let written=0;
  for(const tradeDate of dates){
    const output=path.join(ROOT,'data','close-history',tradeDate+'.json');if(fs.existsSync(output))continue;
    const begin=nextCalendarDate(tradeDate),calendar=await loadDailyBars(request,'000001',begin,today,true),next=calendar.find(b=>b.date>tradeDate&&b.date<=today);
    if(!next)continue;
    const snapshot=JSON.parse(fs.readFileSync(path.join(closeDir,tradeDate+'.result.json'),'utf8')),cache=new Map();
    const lookup=async code=>{if(!cache.has(code))cache.set(code,loadDailyBars(request,code,next.date,next.date).then(rows=>rows.find(b=>b.date===next.date)||null));return cache.get(code)};
    const evaluation=await buildEvaluation(snapshot,next.date,lookup);writeOnce(output,evaluation);written++;
  }
  const index=updateHistoryIndex();console.log(JSON.stringify({today,written,evaluatedDates:index.dates.length}));
}

module.exports={snapshotBasis,parseKlines,parseTencentKlines,loadKlines,loadDailyBars,buildEvaluation,updateHistoryIndex,nextCalendarDate};
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1});
