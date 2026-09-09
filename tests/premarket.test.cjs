const test=require('node:test');
const assert=require('node:assert/strict');
const {createRuntime}=require('../scripts/page-runtime.cjs');
test('premarket rejects late and stale files and accepts a timely empty pool',()=>{
 const r=createRuntime();r.run("tradeDateKey=()=> '2026-09-09'");
 const valid={tradeDate:'2026-09-09',generatedAt:'2026-09-09T08:51:00+08:00',candidates:[]};
 r.context.payload=valid;assert.doesNotThrow(()=>r.run('validatePremarketPool(payload)'));
 for(const patch of [{generatedAt:'2026-09-09T13:07:00+08:00'},{generatedAt:'2026-09-09T09:25:00+08:00'},{tradeDate:'2026-09-08'},{debug:true}]){r.context.payload={...valid,...patch};assert.throws(()=>r.run('validatePremarketPool(payload)'));}
});
test('missing input is displayed separately from zero qualified picks',()=>{
 const r=createRuntime();r.run("premarketState='当日盘前候选缺失；单只观察结果冻结为空';renderPremarket()");
 assert.match(r.elements.get('premarketPick').innerHTML,/数据未就绪/);
 r.run("premarketState='盘前候选 40 只，但没有股票通过竞价确认';renderPremarket()");
 assert.match(r.elements.get('premarketPick').innerHTML,/已完成筛选/);
});
