const test=require('node:test');
const assert=require('node:assert/strict');
const {createRuntime}=require('../scripts/page-runtime.cjs');
function setup(previous,stamp='20260907100000'){
 const qt=[];qt[4]=previous;qt[30]=stamp;
 const rows=Array.from({length:31},(_,i)=>`${String(930+i).padStart(4,'0')} ${10+i/30} ${(i+1)*100}`);
 rows[30]='1000 11 3100';
 const r=createRuntime({fetch:async()=>({ok:true,json:async()=>({data:{sh600001:{qt:{sh600001:qt},data:{date:'20260907',data:rows}}}})})});
 r.run("mode='intraday';tradeDateKey=()=> '2026-09-07';activeWindow=tradingWindow(new Date('2026-09-07T10:00:00+08:00'));fetchJson=async()=>{throw Error('eastmoney unavailable')}");
 return r;
}
test('Tencent fallback computes daily change using verified previous close',async()=>{
 const r=setup(10),s=await r.run("loadWindow({code:'600001',currentChange:0,signals:[]},'intraday')");
 assert.ok(Math.abs(s.currentChange-10)<1e-8);assert.equal(s.minuteProvider,'Tencent');
});
test('missing or stale previous close never retains default zero',async()=>{
 for(const r of [setup(undefined),setup(10,'20260904100000')]){
 const s=await r.run("loadWindow({code:'600001',currentChange:0,signals:[]},'intraday')");
 assert.equal(s.currentChange,null);assert.ok(Number.isFinite(s.windowChange));
 }
});
test('genuine unchanged price remains zero; candidate previous close is usable',async()=>{
 const r=setup(undefined),s=await r.run("loadWindow({code:'600001',previousClose:11,signals:[]},'intraday')");
 assert.equal(s.currentChange,0);
});
