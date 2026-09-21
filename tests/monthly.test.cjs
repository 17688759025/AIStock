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
test('monthly view renders three related board stocks when published data includes them',()=>{
 const nodes=new Map();const document={getElementById(id){if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)}};
 const html=fs.readFileSync(require('node:path').join(__dirname,'../monthly-sectors.html'),'utf8');
 const script=html.split('<script>')[1].split('</script>')[0].replace(/refresh\(\);\s*$/,'');
 const context=vm.createContext({document,Date});vm.runInContext(script,context);
 const row={id:'a',name:'测试方向',score:70,stage:'观察',coverage:{news:true,flow:true,heat:true,domestic:true,foreign:true},weights:{flow:25,news:25,heat:20,domestic:15,foreign:15},factors:{flow:70,news:70,heat:70,domestic:70,foreign:70},positiveNews:1,riskNews:0,flowPositiveDays:3,flowDays:5,overheatPenalty:0,evidence:[],proxyName:'相关ETF',relatedStocks:{board:'半导体',source:'东方财富板块成分行情',asOf:'2026-09-16T09:30:00+08:00',stocks:[{name:'甲',code:'600001',change:3.2,amount:100000000,turnover:2,mainFlow:2000000,relatedScore:90},{name:'乙',code:'600002',change:2.1,amount:80000000,turnover:1,mainFlow:1000000,relatedScore:80},{name:'丙',code:'600003',change:1.2,amount:50000000,turnover:1,mainFlow:500000,relatedScore:70}]}};
 context.payload={month:'2026-09',generatedAt:'2026-09-16T08:00:00+08:00',monthState:{selectedId:'a',events:[]},lookback:{start:'2026-08-20',end:'2026-09-15',dates:Array(15).fill('date')},ranked:[row],sourceStatus:[],errors:[]};
 vm.runInContext('render(payload)',context);
 assert.match(nodes.get('relatedStocks').innerHTML,/相关板块票 Top 3/);assert.match(nodes.get('relatedStocks').innerHTML,/600001/);assert.match(nodes.get('relatedStocks').innerHTML,/600003/);
});
