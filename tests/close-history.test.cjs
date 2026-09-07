const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { snapshotBasis, parseKlines, parseTencentKlines, loadDailyBars, buildEvaluation, updateHistoryIndex, nextCalendarDate } = require('../scripts/update_close_history.cjs');

test('14:30 basis prefers exact quote and can derive a legacy snapshot price', () => {
  assert.deepEqual(snapshotBasis({code:'1',snapshotPrice:10.12,snapshotChange:1.2,previousClose:10}),{price:10.12,change:1.2});
  assert.deepEqual(snapshotBasis({code:'1',currentChange:2,previousClose:10}),{price:10.2,change:2});
  assert.throws(()=>snapshotBasis({code:'1',currentChange:2}),/basis/);
});

test('daily parser and calendar helper preserve the next actual trading date', () => {
  const rows=parseKlines({data:{klines:['2026-09-11,10,10.5,11,9.8,1','bad']}});assert.equal(rows.length,1);assert.equal(rows[0].high,11);
  const tx=parseTencentKlines({data:{sh600001:{day:[['2026-09-11','10','10.5','11','9.8','1']]}}},'sh600001');assert.equal(tx[0].high,11);
  assert.equal(nextCalendarDate('2026-09-11'),'2026-09-12');
});

test('Tencent daily K-line is used when Eastmoney history nodes fail', async () => {
  const calls=[];const bars=await loadDailyBars(async url=>{calls.push(url);if(url.includes('eastmoney'))throw Error('offline');return{data:{sh600001:{day:[['2026-09-14','10','10.5','11','9.8','1']]}}}},'600001','2026-09-14','2026-09-14');
  assert.equal(bars[0].provider,'Tencent');assert.equal(bars[0].high,11);assert.ok(calls.at(-1).includes('fqkline'));
});

test('evaluation uses next-day high relative to frozen 14:30 price for both scopes', async () => {
  const pick={code:'600001',name:'测试',sector:'银行',score:80,snapshotPrice:10,snapshotChange:2,previousClose:9.8};
  const snapshot={tradeDate:'2026-09-11',status:'final',debug:false,snapshotId:'frozen',universes:{main:{picks:[pick]},all:{picks:[pick,{...pick,code:'300001',snapshotPrice:20}]}}};
  let calls=0;const result=await buildEvaluation(snapshot,'2026-09-14',async code=>{calls++;return code==='300001'?null:{date:'2026-09-14',open:10.2,close:10.6,high:11,low:10}} ,'2026-09-14T07:10:00Z');
  assert.equal(calls,2);assert.ok(Math.abs(result.universes.main.picks[0].nextHighReturn-10)<1e-9);assert.equal(result.universes.all.picks[1].suspendedOrMissing,true);
  assert.equal(result.universes.all.evaluatedCount,1);assert.equal(result.universes.all.positiveCount,1);
});

test('history index sorts dates and does not change on a no-op rebuild', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aistock-history-index-')),dir=path.join(root,'data','close-history');fs.mkdirSync(dir,{recursive:true});
  try{for(const date of ['2026-09-11','2026-09-08'])fs.writeFileSync(path.join(dir,date+'.json'),JSON.stringify({evaluatedAt:date+'T07:10:00Z'}));
    const first=updateHistoryIndex(root),content=fs.readFileSync(first.output,'utf8');assert.deepEqual(JSON.parse(content).dates,['2026-09-11','2026-09-08']);updateHistoryIndex(root);assert.equal(fs.readFileSync(first.output,'utf8'),content);
  }finally{fs.rmSync(root,{recursive:true,force:true})}
});
