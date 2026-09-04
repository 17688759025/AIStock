#!/usr/bin/env python3
import argparse, datetime as dt, json, time, urllib.parse, urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

TZ=ZoneInfo('Asia/Shanghai')
SLOTS=[('09:20','09:20:05'),('09:23','09:23:05'),('09:24:50','09:24:50')]
FIELDS='f2,f3,f5,f6,f8,f10,f12,f14,f17,f18,f20,f21,f31,f32,f100'
BASES=['https://push2.eastmoney.com/api/qt/clist/get','https://82.push2.eastmoney.com/api/qt/clist/get','https://20.push2.eastmoney.com/api/qt/clist/get','https://push2delay.eastmoney.com/api/qt/clist/get']

def main_board(code):return str(code).startswith(('600','601','603','605','000','001','002','003'))
def request_json(params,retries=2):
    error=None
    for base in BASES:
        url=base+'?'+urllib.parse.urlencode(params,safe=':+,')
        for attempt in range(retries):
            try:
                req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36','Referer':'https://quote.eastmoney.com/','Accept':'application/json,text/plain,*/*'})
                with urllib.request.urlopen(req,timeout=12) as response:return json.load(response)
            except Exception as exc:
                error=exc;time.sleep(1+attempt)
    raise RuntimeError(f'Eastmoney request failed: {error}')
def fetch_sina_slot():
    rows=[]
    for page in range(1,8):
        params={'num':80,'sort':'changepercent','asc':0,'node':'hs_a','symbol':'','_s_r_a':'page','page':page}
        url='https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?'+urllib.parse.urlencode(params)
        req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Referer':'https://finance.sina.com.cn/'})
        with urllib.request.urlopen(req,timeout=15) as response:page_rows=json.load(response)
        if not isinstance(page_rows,list) or len(page_rows)<70:raise RuntimeError(f'incomplete Sina page {page}: {len(page_rows) if isinstance(page_rows,list) else 0}')
        rows.extend(page_rows)
    result=[]
    for x in rows:
        code=str(x.get('code') or '')
        if main_board(code):result.append({'code':code,'name':x.get('name') or '','price':x.get('trade'),'change':x.get('changepercent'),'volume':x.get('volume'),'amount':x.get('amount'),'turnover':x.get('turnoverratio'),'volumeRatio':None,'open':x.get('open'),'previousClose':x.get('settlement'),'marketCap':x.get('mktcap'),'floatMarketCap':x.get('nmc'),'bid1':x.get('buy'),'ask1':x.get('sell'),'sector':''})
    if len(result)<200:raise RuntimeError(f'incomplete Sina snapshot: {len(result)} rows')
    return result
def fetch_slot():
    params={'pn':1,'pz':500,'po':1,'np':1,'fltt':2,'invt':2,'fid':'f3','fs':'m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23','fields':FIELDS}
    try:data=request_json(params);rows=data.get('data',{}).get('diff') or []
    except Exception:return fetch_sina_slot()
    if isinstance(rows,dict):rows=list(rows.values())
    result=[]
    for x in rows:
        code=str(x.get('f12') or '')
        if not main_board(code):continue
        result.append({'code':code,'name':x.get('f14') or '','price':x.get('f2'),'change':x.get('f3'),'volume':x.get('f5'),'amount':x.get('f6'),'turnover':x.get('f8'),'volumeRatio':x.get('f10'),'open':x.get('f17'),'previousClose':x.get('f18'),'marketCap':x.get('f20'),'floatMarketCap':x.get('f21'),'bid1':x.get('f31'),'ask1':x.get('f32'),'sector':x.get('f100') or ''})
    if len(result)<200:return fetch_sina_slot()
    return result
def wait_until(target):
    while True:
        now=dt.datetime.now(TZ);seconds=(target-now).total_seconds()
        if seconds<=0:return now
        time.sleep(min(30,seconds))
def write_snapshot(output,trade_date,snapshots,debug=False):
    payload={'schemaVersion':1,'tradeDate':trade_date.isoformat(),'timezone':'Asia/Shanghai','source':'Eastmoney ranked top500','debug':debug,'generatedAt':dt.datetime.now(TZ).isoformat(),'snapshots':snapshots}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    return payload
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',default='data/auction/latest.json');p.add_argument('--debug',action='store_true');args=p.parse_args();output=Path(args.output)
    now=dt.datetime.now(TZ);trade_date=now.date()
    if args.debug:
        rows=fetch_slot();payload=write_snapshot(output,trade_date,[{'slot':'debug','capturedAt':dt.datetime.now(TZ).isoformat(),'rows':rows}],True);print(json.dumps({'output':str(output),'rows':len(rows),'generatedAt':payload['generatedAt']},ensure_ascii=False));return
    if trade_date.weekday()>=5:raise SystemExit('weekend: no collection')
    snapshots=[]
    for label,clock in SLOTS:
        h,m,*sec=map(int,clock.split(':'));target=dt.datetime.combine(trade_date,dt.time(h,m,sec[0] if sec else 0),TZ);captured=wait_until(target)
        lateness=(captured-target).total_seconds()
        if lateness>90:raise RuntimeError(f'missed {label} by {lateness:.0f}s')
        rows=fetch_slot();snapshots.append({'slot':label,'capturedAt':dt.datetime.now(TZ).isoformat(),'rows':rows});print(label,len(rows),flush=True)
    if len(snapshots)!=3:raise RuntimeError('three snapshots required')
    dated=output.parent/f'{trade_date.isoformat()}.json';payload=write_snapshot(dated,trade_date,snapshots);write_snapshot(output,trade_date,snapshots)
    print(json.dumps({'output':str(output),'dated':str(dated),'slots':len(snapshots),'generatedAt':payload['generatedAt']},ensure_ascii=False))
if __name__=='__main__':main()
