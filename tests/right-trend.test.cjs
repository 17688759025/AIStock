const test=require('node:test');
const assert=require('node:assert/strict');
const {createRuntime}=require('../scripts/page-runtime.cjs');
function setup(){const r=createRuntime();r.run("tradeDateKey=()=> '2026-09-16';marketParts=()=>({date:'2026-09-16',minutes:920})");return r}
function series(tail=[1,1,1,1,1]){
 const dates=[];for(let d=new Date('2026-07-01T00:00:00Z');dates.length<35;d.setUTCDate(d.getUTCDate()+1))if(![0,6].includes(d.getUTCDay()))dates.push(d.toISOString().slice(0,10));
 let close=10;return dates.map((date,i)=>{const previous=close;close*=1+(i>=30?tail[i-30]:.7)/100;return {date,open:previous,close,high:Math.max(close,previous)*1.002,low:Math.min(close,previous)*.998,volume:10000}});
}
function evaluate(rows,name='测试'){const r=setup();r.context.rows=rows;r.context.calendar=rows.map(x=>x.date);r.context.stock={code:'600001',name};return r.run('evaluateRightSide(stock,rows,calendar)')}
test('four consecutive up closes or 4/5 up closes qualify, 3/5 does not',()=>{
 assert.equal(evaluate(series([-1,1,1,1,1])).streak,4);
 const mixed=evaluate(series([1,1,-.2,1,1]));assert.equal(mixed.red5,4);assert.equal(mixed.streak,2);
 assert.equal(evaluate(series([1,-.2,1,-.2,1])),null);
});
test('red means close above previous close, not above its own open',()=>{
 const rows=series([-1,-1,-1,-1,-1]);rows.forEach(x=>{x.open=x.close*.99;x.low=x.open*.99});assert.equal(evaluate(rows),null);
});
test('intraday and future bars are excluded until close buffer',()=>{
 const r=setup();r.context.rows=[{date:'2026-09-15',open:10,close:11,high:11,low:10,volume:1},{date:'2026-09-16',open:11,close:12,high:12,low:11,volume:1},{date:'2026-09-17',open:12,close:13,high:13,low:12,volume:1}];
 assert.equal(r.run("rightClosedBars(rows,'2026-09-16',900).length"),1);assert.equal(r.run("rightClosedBars(rows,'2026-09-16',910).length"),2);
});
test('missing latest date, suspension gaps, short history and ST are rejected',()=>{
 const r=setup(),rows=series();r.context.rows=rows;r.context.calendar=rows.map(x=>x.date);
 assert.equal(r.run("evaluateRightSide({code:'600001',name:'甲'},rows.slice(0,-1),calendar)"),null);
 assert.equal(r.run("evaluateRightSide({code:'600001',name:'甲'},rows.filter((x,i)=>i!==32),calendar)"),null);
 assert.equal(evaluate(rows.slice(-10)),null);assert.equal(evaluate(rows,'*ST甲'),null);
});
test('overextended move is penalized and near-limit last close excluded',()=>{
 const fast=evaluate(series([7,7,7,7,7]));assert.ok(fast.risks.length);assert.ok(fast.score<evaluate(series()).score);assert.equal(evaluate(series([1,1,1,1,10])),null);
});
test('stale Eastmoney bars fall back to Tencent and valid results cache',async()=>{
 const r=setup();r.context.rows=series();r.context.calendar=r.context.rows.map(x=>x.date);
 r.run('let txCalls=0;rightEastmoneyBars=async()=>rows.slice(0,-1);rightTencentBars=async()=>{txCalls++;return rows}');
 assert.equal((await r.run("loadRightBars({code:'600001'},calendar)")).source,'Tencent');await r.run("loadRightBars({code:'600001'},calendar)");assert.equal(r.run('txCalls'),1);
});
test('peer mode selects five and never calls intraday pipeline',async()=>{
 const r=setup();r.context.rows=series();r.run("mode='rightside';loadRightCalendar=async()=>rows.map(x=>x.date);loadRightSeeds=async()=>({rows:Array.from({length:8},(_,i)=>({code:String(600000+i),name:'趋势'+i})),source:'fixture',failures:[]});loadRightBars=async()=>({rows,source:'fixture'});loadMarket=async()=>{throw Error('must not call intraday')}");
 await r.run('refresh()');assert.equal(r.run('stocks.length'),5);assert.equal(r.run('rightMeta.qualified'),8);assert.match(r.elements.get('stockBody').innerHTML,/5日 5\/5/);assert.match(r.elements.get('dataNote').textContent,/非全市场/);
});
test('late trend response cannot overwrite different mode',async()=>{
 const r=setup();r.run("mode='rightside';loadRightCalendar=async()=>{mode='auction';stocks=[{code:'KEEP'}];return ['2026-09-15']};loadRightSeeds=async()=>{throw Error('must not load after switch')}");await r.run('refresh()');assert.equal(r.run('stocks[0].code'),'KEEP');
});
test('no intraday clock gate and partial failures visible',async()=>{
 const r=setup();r.context.rows=series();r.run("mode='rightside';hhmm=()=>800;loadRightCalendar=async()=>rows.map(x=>x.date);loadRightSeeds=async()=>({rows:[{code:'600001',name:'甲'},{code:'600002',name:'乙'}],source:'fixture',failures:['one page']});loadRightBars=async s=>{if(s.code==='600002')throw Error('offline');return {rows,source:'fixture'}}");assert.equal(r.run('allowed()'),true);await r.run('refresh()');assert.equal(r.run('rightMeta.failed'),1);assert.match(r.elements.get('dataNote').textContent,/部分排行缺失/);
});
