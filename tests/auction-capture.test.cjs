const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {captureWithRetry,validateCapture,digest,mapLimit,writeOnce,buildResult}=require('../scripts/collect_auction_result.cjs');
const {createRuntime}=require('../scripts/page-runtime.cjs');
const date='2026-09-11',at=t=>Date.parse(date+'T'+t+'+08:00');
function fixture(){
 const p={schemaVersion:1,kind:'auction-capture',debug:false,tradeDate:date,captureStartedAt:new Date(at('09:25:03')).toISOString(),captureCompletedAt:new Date(at('09:25:15')).toISOString(),market:{source:'fixture',rows:Array.from({length:4500},(_,i)=>({code:String(600000+i),name:'测试',auction:2.5,currentChange:2.5,amount:1e6,volume:1,signals:[],trend:[0,0,0,0,2.5]}))}};
 p.checksum=digest(p);return p;
}
test('provider failures retry with backoff inside the capture window',async()=>{
 let clock=at('09:25:03'),calls=0;const errors=[],waits=[];
 const result=await captureWithRetry({date,deadline:at('09:29:40'),now:()=>clock,pause:async ms=>{waits.push(ms);clock+=ms},report:e=>errors.push(e),providers:[['Sina',async()=>{throw Error('not ready')}],['Eastmoney',async()=>{if(++calls===1)throw Error('incomplete page');return fixture().market}]]});
 assert.equal(calls,2);assert.deepEqual(waits,[3000]);assert.equal(errors.filter(e=>e.status==='failed').length,3);assert.equal(result.captureStartedAt,new Date(at('09:25:06')).toISOString());
});
test('deadline exhausted exits without spinning or allowing a late successful response',async()=>{
 let clock=at('09:29:59');let calls=0;
 await assert.rejects(captureWithRetry({date,deadline:at('09:30:00'),now:()=>clock,pause:async ms=>clock+=ms,providers:[['late',async()=>{calls++;clock=at('09:30:01');return fixture().market}]]}),/exhausted/);
 assert.equal(calls,1);
 await assert.rejects(captureWithRetry({date,deadline:clock,now:()=>clock,providers:[['unused',async()=>{throw Error('must not run')}]]}),/exhausted/);
});
test('failed batch drains inflight work and stops scheduling additional pages',async()=>{
 const started=[],completed=[];
 await assert.rejects(mapLimit([0,1,2,3],2,async i=>{started.push(i);if(i===0)throw Error('page failure');await new Promise(r=>setTimeout(r,5));completed.push(i)}),/page failure/);
 assert.deepEqual(started,[0,1]);assert.deepEqual(completed,[1]);
});
test('saved raw data rejects corruption, stale/debug and late captures',()=>{
 const p=fixture();assert.equal(validateCapture(p,date),p);
 for(const patch of [{debug:true},{tradeDate:'2026-09-10'},{captureCompletedAt:new Date(at('09:30:00')).toISOString()},{market:{rows:[]}}]){
  const body={...p,...patch};delete body.checksum;body.checksum=digest(body);assert.throws(()=>validateCapture(body,date));
 }
 const broken=structuredClone(p);broken.market.rows[0].amount=0;assert.throws(()=>validateCapture(broken,date),/checksum/);
});
test('saved capture survives failed scoring and supports post-open scoring without new quotes',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'auction-capture-')),file=path.join(dir,'capture.json');
 try{
  const p=fixture();writeOnce(file,p);
  const failed=createRuntime();failed.run('enrichAuctionSectors=async()=>{throw Error("scoring offline")}');
  await assert.rejects(buildResult(failed,structuredClone(p.market),null,{tradeDate:date}),/scoring offline/);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),p);
  const runtime=createRuntime({fetch:async()=>{throw Error('MUST NOT FETCH LIVE QUOTES')}});
  runtime.context.fixedDate=date;
  runtime.run('tradeDateKey=()=>fixedDate;enrichAuctionSectors=async list=>list;enrichAuctionHistory=async list=>list');
  const saved=validateCapture(JSON.parse(fs.readFileSync(file)),date);
  const result=await buildResult(runtime,structuredClone(saved.market),null,{tradeDate:date,captureStartedAt:saved.captureStartedAt,captureCompletedAt:saved.captureCompletedAt});
  result.generatedAt=date+'T11:00:00+08:00';result.snapshotId='late-scoring';runtime.context.result=result;
  assert.doesNotThrow(()=>runtime.run('validateFrozenAuction(result)'));
  assert.equal(result.universes.all.scannedCount,4500);assert.equal(result.universes.main.scannedCount,3000);assert.deepEqual(JSON.parse(fs.readFileSync(file)),p);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('workflow publishes capture before scoring and preserves diagnostics on failure',()=>{
 const y=fs.readFileSync(path.join(__dirname,'../.github/workflows/auction-snapshot.yml'),'utf8');
 assert.ok(y.indexOf('publish-auction-data.sh capture')<y.indexOf('--score-only'));
 assert.ok(y.indexOf('--score-only')<y.indexOf('publish-auction-data.sh result'));
 assert.match(y,/if: always\(\)/);assert.match(y,/auction-collector-diagnostics.jsonl/);
});
