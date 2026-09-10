const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('monthly view shows diagnostic factors on first day instead of a blank waiting panel',()=>{
 const nodes=new Map();const document={getElementById(id){if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)}};
 const html=fs.readFileSync(require('node:path').join(__dirname,'../monthly-sectors.html'),'utf8');
 const script=html.split('<script>')[1].split('</script>')[0].replace(/refresh\(\);\s*$/,'');
 const context=vm.createContext({document,Date});vm.runInContext(script,context);
 const row={id:'a',name:'测试方向',score:20,stage:'证据不足，供比较',coverage:{news:true,flow:false,heat:false,domestic:true,foreign:true},weights:{flow:25,news:25,heat:20,domestic:15,foreign:15},factors:{flow:0,news:20,heat:0,domestic:30,foreign:20},positiveNews:1,riskNews:0,flowPositiveDays:0,flowDays:0,overheatPenalty:0,missing:['flow','heat'],evidence:[],proxyName:'相关ETF'};
 context.payload={month:'2026-09',generatedAt:'2026-09-10T08:00:00+08:00',monthState:{selectedId:null,events:[]},lookback:{start:'2026-08-20',end:'2026-09-09',dates:Array(15).fill('date')},ranked:[row],sourceStatus:[],errors:['资金接口失败']};
 vm.runInContext('render(payload)',context);
 assert.match(nodes.get('status').textContent,/15 个交易日/);
 assert.match(nodes.get('factors').innerHTML,/国内资金/);
 assert.match(nodes.get('focus').innerHTML,/不代表月度确认/);
 assert.match(nodes.get('focus').innerHTML,/3\/5 类证据/);
 assert.match(nodes.get('sources').innerHTML,/资金接口失败/);
});
