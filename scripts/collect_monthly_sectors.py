#!/usr/bin/env python3
"""Observable sector research, not a fitted return predictor. Standard library only."""
import argparse
import concurrent.futures
import datetime as dt
import email.utils
import hashlib
import json
import math
import re
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Shanghai')
ROOT = Path(__file__).resolve().parents[1]
VERSION = 'monthly-evidence-v1'
THEMES = [
    {'id': 'agriculture', 'name': '粮食与种业', 'boards': ['农牧饲渔', '种植业'], 'proxy': 'DBA', 'proxyName': 'DBA 农产品期货组合', 'words': ['粮食', '种业', '小麦', '玉米', '大豆', 'grain', 'wheat', 'corn', 'soybean']},
    {'id': 'chemicals', 'name': '化工与化肥', 'boards': ['化学原料', '化学制品', '化肥行业'], 'proxy': 'XLB', 'proxyName': 'XLB 美国材料行业（宽口径代理）', 'words': ['化工', '化肥', '尿素', '磷肥', 'chemical', 'fertilizer', 'potash']},
    {'id': 'semiconductors', 'name': '存储与半导体', 'boards': ['半导体'], 'proxy': 'SOXX', 'proxyName': 'SOXX 美国半导体行业', 'words': ['半导体', '存储芯片', '存储器', 'dram', 'nand', 'hbm', 'micron', 'semiconductor', 'memory chip']},
    {'id': 'computing', 'name': '算力与通信', 'boards': ['通信设备', '计算机设备'], 'proxy': 'QQQ', 'proxyName': 'QQQ 纳斯达克100（宽口径代理）', 'words': ['算力', '数据中心', '光模块', '服务器', 'data center', 'datacenter', 'ai infrastructure']},
    {'id': 'energy', 'name': '石油与天然气', 'boards': ['石油行业', '燃气'], 'proxy': 'XLE', 'proxyName': 'XLE 美国能源行业', 'words': ['原油', '天然气', '石油', 'opec', 'crude', 'natural gas', 'lng']},
    {'id': 'metals', 'name': '有色金属', 'boards': ['有色金属', '工业金属', '小金属'], 'proxy': 'DBB', 'proxyName': 'DBB 工业金属期货组合', 'words': ['铜价', '铝价', '稀土', '工业金属', 'copper', 'aluminum', 'rare earth']},
    {'id': 'gold', 'name': '黄金与贵金属', 'boards': ['贵金属'], 'proxy': 'GLD', 'proxyName': 'GLD 黄金价格代理', 'words': ['黄金', '金价', '贵金属', 'gold', 'bullion']},
    {'id': 'biotech', 'name': '创新药与生物医药', 'boards': ['生物制品', '化学制药'], 'proxy': 'XBI', 'proxyName': 'XBI 美国生物科技行业', 'words': ['创新药', '临床试验', '药品获批', 'biotech', 'clinical trial', 'drug approval']},
]
FEEDS = [
    ('中新网财经', 'domestic', 'https://www.chinanews.com.cn/rss/finance.xml'),
    ('中新网国际', 'international', 'https://www.chinanews.com.cn/rss/world.xml'),
    ('CNBC国际', 'international', 'https://www.cnbc.com/id/100727362/device/rss/rss.html'),
    ('CNBC科技', 'international', 'https://www.cnbc.com/id/19854910/device/rss/rss.html'),
]
POSITIVE = ['涨价', '提价', '供不应求', '扩产', '订单增长', '获批', '突破', '补贴', '增持', '预增', 'surge', 'record demand', 'shortage', 'approval', 'raises forecast', 'price hike']
NEGATIVE = ['过剩', '降价', '减产', '下滑', '制裁', '禁令', '暴跌', '预减', '亏损', 'oversupply', 'slump', 'ban', 'sanction', 'weak demand', 'cuts forecast']


def request(url, xml=False):
    error = None
    for attempt in range(2):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/'})
            with urllib.request.urlopen(req, timeout=12) as response:
                raw = response.read(4_000_000)
            return ET.fromstring(raw) if xml else json.loads(raw)
        except Exception as exc:
            error = exc
            if not attempt:
                time.sleep(.5)
    raise RuntimeError(str(error))


def number(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def clamp(value, lo=0, hi=100):
    return max(lo, min(hi, value))


def mentions(title, words):
    title = title.casefold()
    return any(re.search(r'\b'+re.escape(w)+r'\b', title) if w.isascii() else w in title for w in words)


def news_item(title, link, published, source, region, now):
    try:
        stamp = email.utils.parsedate_to_datetime(published)
    except (ValueError, TypeError):
        try:
            stamp = dt.datetime.fromisoformat(published)
        except (ValueError, TypeError):
            return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=TZ)
    if stamp > now or (now-stamp).total_seconds() > 21*86400 or not link.startswith(('https://', 'http://')):
        return None
    title = re.sub('<[^>]+>', '', title).strip()[:180]
    key = hashlib.sha256(re.sub(r'\W+', '', title.casefold()).encode()).hexdigest()[:20]
    return {'id': key, 'title': title, 'url': link, 'publishedAt': stamp.isoformat(), 'source': source, 'region': region, 'firstSeenAt': now.isoformat()}


def fetch_news(feed, now):
    source, region, url = feed
    root = request(url, xml=True)
    rows = []
    for item in root.findall('.//item'):
        row = news_item(item.findtext('title') or '', item.findtext('link') or '', item.findtext('pubDate') or '', source, region, now)
        if row:
            rows.append(row)
    if not rows:
        raise RuntimeError('no fresh dated RSS items')
    return rows


def board_market(now):
    params = {'pz': 100, 'po': 1, 'np': 1, 'fltt': 2, 'invt': 2, 'fid': 'f12', 'fs': 'm:90+t:2', 'fields': 'f12,f14,f3,f62,f184,f124'}
    rows, expected = [], None
    for page in range(1, 13):
        j = request('https://push2.eastmoney.com/api/qt/clist/get?' + urllib.parse.urlencode(dict(params, pn=page)))
        data = j.get('data') or {}
        expected = int(data.get('total') or 0)
        chunk = data.get('diff') or []
        rows.extend(chunk.values() if isinstance(chunk, dict) else chunk)
        if len(rows) >= expected:
            break
    if not expected or len({r['f12'] for r in rows}) < expected:
        raise RuntimeError('incomplete sector universe')
    # A fresh timestamp is required for a usable cumulative flow observation.
    valid = []
    for r in rows:
        ts = number(r.get('f124'))
        date = dt.datetime.fromtimestamp(ts, TZ).date() if ts else None
        if date == now.date() and number(r.get('f62')) is not None:
            valid.append(r)
    if not valid:
        raise RuntimeError('no sector flow observations dated today')
    return valid


def price_features(bars, now):
    # Completed sessions only: live bars cannot masquerade as closing returns.
    bars = sorted({d: p for d, p in bars if d < now.date().isoformat() and number(p) is not None and p > 0}.items())
    if len(bars) < 21 or (now.date()-dt.date.fromisoformat(bars[-1][0])).days > 7:
        raise RuntimeError('insufficient or stale completed price sessions')
    values = [p for _, p in bars]
    return {'asOf': bars[-1][0], 'return5': (values[-1]/values[-6]-1)*100,
            'return20': (values[-1]/values[-21]-1)*100, 'nearHigh': values[-1]/max(values[-21:])*100}


def foreign_price(symbol, now):
    url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?range=3mo&interval=1d'
    j = request(url)['chart']['result'][0]
    closes = j['indicators']['quote'][0]['close']
    # Exchange-local dates, not the Shanghai calendar date of an overseas close.
    tz = ZoneInfo(j['meta'].get('exchangeTimezoneName', 'America/New_York'))
    bars = [(dt.datetime.fromtimestamp(t, tz).date().isoformat(), p) for t, p in zip(j['timestamp'], closes) if number(p) is not None]
    result = price_features(bars, now)
    result['sourceUrl'] = 'https://finance.yahoo.com/quote/'+symbol+'/'
    return result


def domestic_price(code, now):
    params = {'secid': '90.'+code, 'klt': 101, 'fqt': 0, 'lmt': 65, 'beg': (now.date()-dt.timedelta(days=180)).strftime('%Y%m%d'), 'end': '20500101', 'fields1': 'f1,f2,f3,f4,f5,f6', 'fields2': 'f51,f52,f53,f54,f55,f56'}
    j = request('https://push2his.eastmoney.com/api/qt/stock/kline/get?'+urllib.parse.urlencode(params))
    bars = [(p[0], float(p[2])) for p in (x.split(',') for x in (j.get('data') or {}).get('klines') or [])]
    return price_features(bars, now)


def merge_news(previous, incoming, now):
    result = {}
    for n in previous+incoming:
        try:
            stamp = dt.datetime.fromisoformat(n['publishedAt'])
            if stamp <= now and now-stamp <= dt.timedelta(days=21):
                result.setdefault(n['id'], n)
        except (KeyError, ValueError, TypeError):
            continue
    return sorted(result.values(), key=lambda n: n['publishedAt'], reverse=True)[:1500]


def daily_observations(history, current):
    unique = {x['date']: x for x in history if x['date'] <= current['date']}
    unique[current['date']] = current
    return [unique[d] for d in sorted(unique)][-30:]


def score_theme(theme, news, days, now):
    latest = days[-1]['themes'].get(theme['id'], {})
    evidence = [n for n in news if mentions(n['title'], theme['words'])]
    positive = [n for n in evidence if mentions(n['title'], POSITIVE) and not mentions(n['title'], NEGATIVE)]
    negative = [n for n in evidence if mentions(n['title'], NEGATIVE)]
    # Titles identify research leads; they do not establish a causal profit effect.
    news_score = clamp(len(positive)*18 + min(25, len(evidence)*3) + min(15, len({n['source'] for n in evidence})*5) - len(negative)*12)
    flows = [x['themes'].get(theme['id'], {}).get('flow') for x in days[-5:]]
    flows = [x for x in flows if x is not None]
    current_flow = latest.get('flow')
    flow_score = clamp(50 + (latest.get('flowRatio') or 0)*5) if current_flow is not None else 0
    if flows and current_flow is not None:
        flow_score = .5*flow_score + .5*100*sum(x > 0 for x in flows)/len(flows)
    foreign, domestic = latest.get('foreign'), latest.get('domestic')
    foreign_score = clamp(45+foreign['return5']*3+foreign['return20']) if foreign else 0
    domestic_score = clamp(45+domestic['return5']*3) if domestic else 0
    active_days = sum(1 for x in days[-10:] if (x['themes'].get(theme['id'], {}).get('flow') or 0) > 0)
    persistence = min(100, active_days*20)
    penalty = min(35, max(0, domestic['return20']-12)*1.5+max(0, domestic['return5']-6)*2) if domestic else 0
    factors = {'news': round(news_score, 1), 'flow': round(flow_score, 1), 'foreign': round(foreign_score, 1), 'domestic': round(domestic_score, 1), 'persistence': persistence}
    weights = {'news': 30, 'flow': 25, 'foreign': 20, 'domestic': 15, 'persistence': 10}
    coverage = {'news': bool(evidence), 'flow': current_flow is not None, 'foreign': foreign is not None, 'domestic': domestic is not None}
    score = round(clamp(sum(factors[k]*w/100 for k, w in weights.items())-penalty), 1)
    count = sum(coverage.values())
    eligible = count >= 3 and coverage['domestic'] and coverage['news'] and len(positive) >= 1 and score >= 55 and penalty < 20 and len(days) >= 3
    return {**theme, 'score': score, 'eligible': eligible, 'coverage': coverage, 'factors': factors, 'weights': weights,
            'overheatPenalty': round(penalty, 1), 'positiveNews': len(positive), 'riskNews': len(negative),
            'observedDays': len(days), 'flowPositiveDays': sum(x > 0 for x in flows), 'flowDays': len(flows),
            'flow': current_flow, 'foreign': foreign, 'domestic': domestic, 'evidence': evidence[:8],
            'stage': '涨幅偏高' if penalty >= 20 else '证据不足' if count < 3 else '初步观察' if len(days) < 3 else '持续跟踪'}


def choose_month(ranked, previous, days, now):
    month = now.strftime('%Y-%m')
    state = previous if previous.get('month') == month else {'month': month, 'selectedId': None, 'events': []}
    state = json.loads(json.dumps(state))
    qualified = [r for r in ranked if r['eligible']]
    current = next((r for r in ranked if r['id'] == state.get('selectedId')), None)
    challenger = qualified[0] if qualified else None
    if current is None and challenger:
        state.update(selectedId=challenger['id'], selectedAt=now.isoformat())
        state['events'].append({'at': now.isoformat(), 'type': 'selected', 'id': challenger['id'], 'score': challenger['score']})
    elif current and challenger and challenger['id'] != current['id'] and challenger['score'] >= current['score']+8:
        # Require the same challenger on three different dates, not three refreshes.
        recent = days[-3:]
        if len(recent) == 3 and all(x.get('leader') == challenger['id'] for x in recent):
            state['events'].append({'at': now.isoformat(), 'type': 'changed', 'from': current['id'], 'id': challenger['id'], 'score': challenger['score']})
            state.update(selectedId=challenger['id'], selectedAt=now.isoformat())
    selected = next((r for r in ranked if r['id'] == state.get('selectedId')), None)
    state['status'] = '跟踪中' if selected and selected['eligible'] else '证据转弱，暂停确认' if selected else '积累证据中'
    state['updatedAt'] = now.isoformat()
    return state


def read_json(path, fallback):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return fallback


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    temp.replace(path)


def collect(root, now):
    directory = root/'data/monthly'
    previous = read_json(directory/'latest.json', {})
    history = read_json(directory/'history.json', [])
    news, failures, source_status = [], [], []
    observations = {t['id']: {} for t in THEMES}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        jobs = {pool.submit(fetch_news, f, now): ('news', f[0]) for f in FEEDS}
        jobs[pool.submit(board_market, now)] = ('boards', '东方财富行业资金')
        for t in THEMES:
            jobs[pool.submit(foreign_price, t['proxy'], now)] = ('foreign', t['id'])
        boards = []
        for job in concurrent.futures.as_completed(jobs):
            kind, label = jobs[job]
            try:
                data = job.result()
                if kind == 'news':
                    news.extend(data)
                elif kind == 'boards':
                    boards = data
                else:
                    observations[label]['foreign'] = data
                source_status.append({'source': label, 'ok': True, 'checkedAt': now.isoformat()})
            except Exception as exc:
                failures.append(label+': '+str(exc)[:140])
                source_status.append({'source': label, 'ok': False, 'checkedAt': now.isoformat()})
        jobs = {}
        for t in THEMES:
            matches = [b for name in t['boards'] for b in boards if b['f14'] == name]
            if matches:
                flows = [number(b.get('f62')) for b in matches]
                ratios = [number(b.get('f184')) for b in matches]
                observations[t['id']].update(flow=sum(x for x in flows if x is not None), flowRatio=sum(x for x in ratios if x is not None)/max(1, sum(x is not None for x in ratios)), boardNames=[b['f14'] for b in matches])
                jobs[pool.submit(domestic_price, matches[0]['f12'], now)] = t['id']
        for job in concurrent.futures.as_completed(jobs):
            try:
                observations[jobs[job]]['domestic'] = job.result()
                source_status.append({'source': jobs[job]+'国内价格', 'ok': True, 'checkedAt': now.isoformat()})
            except Exception as exc:
                failures.append(jobs[job]+'国内价格: '+str(exc)[:140])
                source_status.append({'source': jobs[job]+'国内价格', 'ok': False, 'checkedAt': now.isoformat()})
    merged = merge_news(previous.get('news', []), news, now)
    current = {'date': now.date().isoformat(), 'at': now.isoformat(), 'themes': observations}
    days = daily_observations(history, current)
    ranked = sorted([score_theme(t, merged, days, now) for t in THEMES], key=lambda t: (-t['score'], t['id']))
    current['leader'] = next((r['id'] for r in ranked if r['eligible']), None)
    days = daily_observations(history, current)
    state = choose_month(ranked, previous.get('monthState', {}), days, now)
    payload = {'schemaVersion': 1, 'modelVersion': VERSION, 'generatedAt': now.isoformat(), 'month': now.strftime('%Y-%m'),
               'monthState': state, 'ranked': ranked, 'news': merged, 'sourceStatus': source_status, 'errors': failures,
               'observedDays': len(days), 'method': '关键词线索 + 公开资金口径 + 价格代理；分数不是胜率，外盘价格不是外资净流入'}
    # A failed run is auditable, while keeping the last useful day for persistence.
    usable = bool(news or any(o for o in observations.values()))
    payload['usable'] = usable
    stamp = now.strftime('%Y-%m-%dT%H%M%S')
    write_json(directory/'runs'/f'{stamp}.json', payload)
    if usable:
        write_json(directory/'history.json', days)
        write_json(directory/'months'/f'{payload["month"]}.json', state)
        write_json(directory/'latest.json', payload)
    else:
        raise RuntimeError('all sources unavailable; kept last successful latest.json')
    print(json.dumps({'observedDays': len(days), 'selected': state['selectedId'], 'news': len(merged), 'failures': len(failures)}, ensure_ascii=False))
    return payload


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    collect(args.root, dt.datetime.now(TZ))
