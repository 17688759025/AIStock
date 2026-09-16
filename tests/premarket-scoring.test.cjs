const test=require('node:test');
const assert=require('node:assert/strict');
const {createRuntime}=require('../scripts/page-runtime.cjs');
function setup(){const r=createRuntime();r.run(`const candidate={code:'600001',name:'测试',catalystScore:19.44,premarketScore:46.38,limitScore:0};const quote={code:'600001',name:'测试',auction:2.5,currentChange:2.5,amount:100000};const pool={sourceCoverage:{previousLimitPool:false}}`);return r}
test('missing limit coverage is not treated as confirmed zero performance',()=>{const r=setup();const unknown=r.run('evaluatePremarketCandidate(candidate,quote,pool)');const known=r.run('evaluatePremarketCandidate(candidate,quote,{sourceCoverage:{previousLimitPool:true}})');assert.ok(unknown.finalEventScore>known.finalEventScore);assert.ok(unknown.missingFactors.some(x=>x.includes('涨停池')));assert.equal(unknown.amountScore,null);assert.ok(unknown.finalEventScore>=60)});
test('amount only scores with explicit comparable auction baseline',()=>{const r=setup();assert.equal(r.run('evaluatePremarketCandidate(candidate,{...quote,auctionAmountBaseline:100000},pool).amountScore'),null);assert.equal(r.run("evaluatePremarketCandidate(candidate,{...quote,amountBasis:'auction',auctionAmountBaseline:100000},pool).amountScore"),50)});
test('missing quotes, ST and procedural announcements cannot qualify',()=>{const r=setup();for(const expression of ['candidate,undefined,pool',"{...candidate,name:'*ST测试'},quote,pool","{...candidate,events:[{eventType:'定期报告',eventTitle:'年报更正'}]},quote,pool"]){assert.ok(r.run('evaluatePremarketCandidate('+expression+').rejectionReasons.length')>0)}});
test('diagnostics distinguish missing input and candidates rejected by score',async()=>{const r=setup();await r.run("preparePremarketObservation([quote],{...pool,candidates:[candidate,{...candidate,code:'600002'}]})");assert.equal(r.run('premarketPick.code'),'600001');assert.match(r.elements.get('premarketPick').innerHTML,/当日报价缺失/);assert.match(r.elements.get('premarketPick').innerHTML,/候选评分明细/)});
test('a weak catalyst remains visible with a low-score flag and results do not depend on pool size',()=>{const r=setup();const weak=r.run('evaluatePremarketCandidate({...candidate,catalystScore:5},quote,pool)');assert.ok(weak.finalEventScore<50);assert.equal(weak.rejectionReasons.length,0);assert.equal(weak.belowReference,true);assert.equal(r.run('evaluatePremarketCandidate(candidate,quote,pool).finalEventScore'),r.run('evaluatePremarketCandidate(candidate,{...quote,amount:999999999},pool).finalEventScore'))});
test('reference score never blocks display, still selecting at most one',async()=>{
 const r=setup();assert.equal(r.run('PREMARKET_REFERENCE_SCORE'),50);
 for(const score of [49,50,55,59]){
  r.context.target=score;
  const x=r.run('evaluatePremarketCandidate({code:"600001",name:"测试",premarketScore:(target*.91-auctionGapQuality(2.5)*.21)/.7},quote,pool)');
  assert.equal(x.finalEventScore,score);assert.equal(x.rejectionReasons.length,0);assert.equal(x.belowReference,score<50);
 }
 await r.run('preparePremarketObservation([quote,{...quote,code:"600002"}],{...pool,candidates:[{code:"600001",name:"甲",premarketScore:40},{code:"600002",name:"乙",premarketScore:39}]})');
 assert.equal(r.run('premarketPick.code'),'600001');assert.match(r.run('premarketState'),/最终1只.*参考线 50/);
});
test('below-50 winner renders its numeric score and warning; invalid inputs remain excluded',async()=>{
 const r=setup();await r.run('preparePremarketObservation([quote],{...pool,candidates:[{...candidate,catalystScore:5}]})');
 assert.ok(r.run('premarketPick.finalEventScore')<50);assert.match(r.elements.get('premarketPick').innerHTML,/分 · 低于参考线/);
 await r.run('preparePremarketObservation([{...quote,amount:0}],{...pool,candidates:[candidate]})');assert.equal(r.run('premarketPick'),null);
});
