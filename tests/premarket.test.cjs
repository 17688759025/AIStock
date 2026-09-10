const test=require('node:test');
const assert=require('node:assert/strict');
const {createRuntime}=require('../scripts/page-runtime.cjs');
test('observation accepts delayed files but rejects stale or debug inputs',()=>{
 const r=createRuntime();r.run("tradeDateKey=()=> '2026-09-09'");
 const valid={tradeDate:'2026-09-09',generatedAt:'2026-09-09T08:51:00+08:00',candidates:[]};
 r.context.payload=valid;assert.doesNotThrow(()=>r.run('validatePremarketPool(payload)'));
 for(const generatedAt of ['2026-09-09T13:07:00+08:00','2026-09-09T09:25:00+08:00']){r.context.payload={...valid,generatedAt};assert.doesNotThrow(()=>r.run('validatePremarketPool(payload)'));}
 for(const patch of [{tradeDate:'2026-09-08'},{debug:true}]){r.context.payload={...valid,...patch};assert.throws(()=>r.run('validatePremarketPool(payload)'));}
});
test('late pool can populate a previously missing observation without modifying frozen picks',async()=>{
 const r=createRuntime();r.run("tradeDateKey=()=> '2026-09-09';hhmm=()=>1300;premarketState='当日盘前候选缺失';stocks=[{code:'600002',frozenAuction:true,score:90}];loadPremarketPool=async()=>({tradeDate:'2026-09-09',generatedAt:'2026-09-09T13:00:00+08:00',candidates:[{code:'600001',name:'测试',premarketScore:95,events:[]}]});fetchJson=async()=>({data:{diff:[{f12:'600001',f14:'测试',f17:10.2,f18:10,f3:3,f6:100000,f8:1,f10:2,f124:Date.parse('2026-09-09T13:00:00+08:00')/1000}]}})");
 await r.run('refreshDelayedPremarket()');assert.equal(r.run('premarketPick.code'),'600001');assert.equal(r.run('premarketPick.delayed'),true);assert.match(r.run('premarketState'),/延迟观察/);assert.equal(r.run('stocks[0].code'),'600002');
});
test('missing input is displayed separately from zero qualified picks',()=>{
 const r=createRuntime();r.run("premarketState='当日盘前候选缺失；单只观察结果冻结为空';renderPremarket()");
 assert.match(r.elements.get('premarketPick').innerHTML,/数据未就绪/);
 r.run("premarketState='盘前候选 40 只，但没有股票通过竞价确认';renderPremarket()");
 assert.match(r.elements.get('premarketPick').innerHTML,/已完成筛选/);
});
test('Tencent supplies missing Eastmoney quotes with verified dates and amount units',async()=>{
 const r=createRuntime();r.run("tradeDateKey=()=> '2026-09-09';fetchJson=async()=>{throw Error('eastmoney offline')}");
 const q=[];q[1]='测试';q[3]='10.3';q[4]='10';q[5]='10.2';q[30]='20260909092600';q[37]='20';q[38]='1';
 r.context.fetch=async()=>({ok:true,json:async()=>({data:{sh600001:{qt:{sh600001:q}}}})});
 const rows=await r.run("loadPremarketQuotes([{code:'600001',name:'测试'}])");
 assert.equal(rows.length,1);assert.equal(rows[0].amount,200000);assert.ok(Math.abs(rows[0].auction-2)<.0001);
 q[30]='20260908092600';assert.equal((await r.run("loadPremarketQuotes([{code:'600001'}])")).length,0);
});
test('partial observation is displayed but not frozen, and next refresh retries missing quotes',async()=>{
 const r=createRuntime();r.run("tradeDateKey=()=> '2026-09-09';hhmm=()=>926;premarketState='当日盘前候选缺失';loadPremarketPool=async()=>({tradeDate:'2026-09-09',generatedAt:'2026-09-09T08:50:00+08:00',candidates:[{code:'600001',name:'甲',premarketScore:95,events:[]},{code:'600002',name:'乙',premarketScore:95,events:[]}]});let quoteCalls=0;loadPremarketQuotes=async()=>{quoteCalls++;return normalize([{f12:'600001',f14:'甲',f17:10.2,f18:10,f3:3,f6:100000,f10:2}])}");
 await r.run('refreshDelayedPremarket()');assert.equal(r.run('premarketPick.code'),'600001');assert.match(r.run('premarketState'),/部分报价临时结果 1\/2/);assert.equal(r.run('delayedObservation'),null);
 await r.run('refreshDelayedPremarket()');assert.equal(r.run('quoteCalls'),2);
});
