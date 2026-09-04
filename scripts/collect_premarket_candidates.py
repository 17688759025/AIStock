#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Shanghai')
ANN_URL = 'https://np-anotice-stock.eastmoney.com/api/security/ann'
LIMIT_URL = 'https://push2ex.eastmoney.com/getTopicZTPool'
HEADERS = {'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Referer': 'https://data.eastmoney.com/', 'Accept': 'application/json,text/plain,*/*'}
POSITIVE_EVENTS = [
    (('业绩预增', '扭亏为盈', '业绩快报'), '业绩改善', 27),
    (('半年度报告', '年度报告', '季度报告'), '定期报告', 17),
    (('重大合同', '中标', '订单'), '合同订单', 21),
    (('回购', '增持'), '回购增持', 16),
    (('并购', '重组', '资产收购', '控制权变更'), '并购重组', 19),
    (('股权激励', '员工持股'), '激励计划', 13),
]
NEGATIVE_WORDS = ('减持', '立案', '调查', '处罚', '问询函', '风险提示', '终止', '亏损', '业绩预减', '退市', '诉讼', '冻结', '质押')

def request_json(url, params, retries=3):
    error = None
    target = url + '?' + urllib.parse.urlencode(params, safe=':+,')
    for attempt in range(retries):
        try:
            req = urllib.request.Request(target, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=18) as response:
                return json.load(response)
        except Exception as exc:
            error = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f'request failed: {error}')

def a_share(code):
    return str(code).startswith(('600', '601', '603', '605', '000', '001', '002', '003', '300', '301', '688', '689', '8', '9'))

def classify_event(title):
    if any(word in title for word in NEGATIVE_WORDS):
        return None
    for words, label, score in POSITIVE_EVENTS:
        if any(word in title for word in words):
            return label, score
    return None

def fetch_announcements(now):
    result = []
    for page in range(1, 5):
        payload = request_json(ANN_URL, {'sr': -1, 'page_size': 100, 'page_index': page, 'ann_type': 'A', 'client_source': 'web', 'f_node': 0, 's_node': 0})
        rows = payload.get('data', {}).get('list') or []
        for ann in rows:
            title = ann.get('title_ch') or ann.get('title') or ''
            event = classify_event(title)
            if not event:
                continue
            raw_time = (ann.get('display_time') or ann.get('notice_date') or '')[:19]
            try:
                published = dt.datetime.fromisoformat(raw_time).replace(tzinfo=TZ)
            except ValueError:
                continue
            age_hours = max(0, (now - published).total_seconds() / 3600)
            if age_hours > 120:
                continue
            decay = max(.35, 1 - age_hours / 168)
            label, base = event
            for stock in ann.get('codes') or []:
                code = str(stock.get('stock_code') or '')
                if a_share(code):
                    result.append({'code': code, 'name': stock.get('short_name') or '', 'eventType': label, 'eventTitle': title, 'eventPublishedAt': published.isoformat(), 'eventAgeHours': round(age_hours, 1), 'eventScore': round(base * decay, 2), 'announcementId': ann.get('art_code') or ''})
        if len(rows) < 100:
            break
    return result

def fetch_limit_pool(now):
    payload = request_json(LIMIT_URL, {'ut': '7eea3edcaed734bea9cbfc24409ed989', 'dpt': 'wz.ztzt', 'Pageindex': 0, 'pagesize': 500, 'sort': 'fbt:asc', 'date': now.strftime('%Y%m%d')})
    data = payload.get('data') or {}
    rows = []
    for x in data.get('pool') or []:
        code = str(x.get('c') or '')
        if not a_share(code):
            continue
        float_cap = float(x.get('ltsz') or 0)
        seal_amount = float(x.get('fund') or 0)
        turnover = float(x.get('hs') or 0)
        breaks = int(x.get('zbc') or 0)
        boards = int(x.get('lbc') or 1)
        seal_ratio = seal_amount / float_cap * 100 if float_cap > 0 else 0
        quality = 18 + min(10, seal_ratio * 3) + max(0, 7 - abs(turnover - 8) * .55) + (4 if boards == 1 else max(-5, 3 - boards)) - min(10, breaks * 2.5)
        rows.append({'code': code, 'name': x.get('n') or '', 'limitUp': True, 'limitDate': str(data.get('qdate') or ''), 'limitBoards': boards, 'limitBreaks': breaks, 'limitFirstTime': str(x.get('fbt') or ''), 'limitLastTime': str(x.get('lbt') or ''), 'limitTurnover': turnover, 'limitAmount': float(x.get('amount') or 0), 'limitSealAmount': seal_amount, 'limitSealRatio': round(seal_ratio, 3), 'limitScore': round(max(0, min(40, quality)), 2), 'sector': x.get('hybk') or ''})
    return rows, str(data.get('qdate') or '')

def merge_candidates(announcements, limits):
    merged = {}
    for row in limits:
        merged[row['code']] = dict(row, events=[])
    for row in announcements:
        stock = merged.setdefault(row['code'], {'code': row['code'], 'name': row['name'], 'limitUp': False, 'limitScore': 0, 'events': []})
        stock['events'].append(row)
        if not stock.get('name'):
            stock['name'] = row['name']
    output = []
    for stock in merged.values():
        events = sorted(stock.get('events') or [], key=lambda x: x['eventScore'], reverse=True)
        event_score = events[0]['eventScore'] if events else 0
        extra = sum(x['eventScore'] for x in events[1:3]) * .18
        catalyst = min(40, event_score + extra)
        limit_score = float(stock.get('limitScore') or 0)
        synergy = 8 if catalyst > 0 and limit_score > 0 else 0
        score = min(100, 25 + catalyst * 1.1 + limit_score * .9 + synergy)
        if score < 42:
            continue
        stock['events'] = events[:3]
        stock['catalystScore'] = round(catalyst, 2)
        stock['premarketScore'] = round(score, 2)
        stock['primaryConcept'] = events[0]['eventType'] if events else ('昨日涨停' if stock.get('limitUp') else '事件驱动')
        output.append(stock)
    return sorted(output, key=lambda x: (-x['premarketScore'], x['code']))[:40]

def wait_until_0850(now):
    target = dt.datetime.combine(now.date(), dt.time(8, 50), TZ)
    while now < target:
        time.sleep(min(30, (target - now).total_seconds()))
        now = dt.datetime.now(TZ)
    return now

def write_payload(output, payload):
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='data/premarket/latest.json')
    parser.add_argument('--debug', action='store_true')
    parser.add_argument('--no-wait', action='store_true')
    args = parser.parse_args()
    now = dt.datetime.now(TZ)
    if now.date().weekday() >= 5 and not args.debug:
        raise SystemExit('weekend: no collection')
    if not args.no_wait and not args.debug:
        now = wait_until_0850(now)
    announcements = fetch_announcements(now)
    limits, limit_date = fetch_limit_pool(now)
    candidates = merge_candidates(announcements, limits)
    if not candidates:
        raise RuntimeError('no premarket candidates collected')
    payload = {'schemaVersion': 1, 'tradeDate': now.date().isoformat(), 'timezone': 'Asia/Shanghai', 'generatedAt': dt.datetime.now(TZ).isoformat(), 'source': 'Eastmoney announcements + latest limit-up pool', 'debug': bool(args.debug), 'limitPoolDate': limit_date, 'candidateCount': len(candidates), 'candidates': candidates}
    output = Path(args.output)
    write_payload(output, payload)
    if not args.debug:
        write_payload(output.parent / f'{now.date().isoformat()}.json', payload)
    print(json.dumps({'output': str(output), 'announcements': len(announcements), 'limitUps': len(limits), 'candidates': len(candidates), 'limitPoolDate': limit_date}, ensure_ascii=False))

if __name__ == '__main__':
    main()
