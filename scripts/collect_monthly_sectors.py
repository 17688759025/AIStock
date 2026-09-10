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
import subprocess
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo('Asia/Shanghai')
ROOT = Path(__file__).resolve().parents[1]
VERSION = 'monthly-evidence-v2-lookback15'
LOOKBACK = 15
THEMES = [
    {'id': 'agriculture', 'name': '粮食与种业', 'boards': ['农牧饲渔', '种植业'], 'proxy': 'DBA', 'proxyName': 'DBA 农产品期货组合', 'words': ['粮食', '种业', '小麦', '玉米', '大豆', 'grain', 'wheat', 'corn', 'soybean']},
    {'id': 'chemicals', 'name': '化工与化肥', 'boards': ['化学原料', '化学制品', '化肥行业'], 'proxy': 'XLB', 'proxyName': 'XLB 美国材料行业（宽口径代理）', 'words': ['化工', '化肥', '尿素', '磷肥', 'chemical', 'fertilizer', 'potash']},
    {'id': 'semiconductors', 'name': '存储与半导体', 'boards': ['半导体'], 'proxy': 'SOXX', 'proxyName': 'SOXX 美国半导体行业', 'words': ['半导体', '存储芯片', '存储器', 'dram', 'nand', 'hbm', 'micron', 'semiconductor', 'memory chip']},
    {'id': 'computing', 'name': '算力与通信', 'boards': ['通信设备', '计算机设备'], 'proxy': 'QQQ', 'proxyName': 'QQQ 纳斯达克100（宽口径代理）', 'words': ['算力', '数据中心', '光模块', '服务器', 'data center', 'datacenter', 'ai infrastructure']},
    {'id': 'energy', 'name': '石油与天然气', 'boards': ['石油石化', '石油行业', '燃气'], 'proxy': 'XLE', 'proxyName': 'XLE 美国能源行业', 'words': ['原油', '天然气', '石油', 'opec', 'crude', 'natural gas', 'lng']},
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
            if xml:
                return ET.fromstring(raw)
            text = raw.decode('utf-8')
            if text.startswith('monthlyCallback('):
                text = text[len('monthlyCallback('):].rstrip().removesuffix(';').removesuffix(')')
            return json.loads(text)
        except Exception as exc:
            error = exc
            if not attempt:
                time.sleep(.5)
    # Some quote gateways close Python's HTTP connection while serving curl.
    # Bounded transport fallback only; no credentials, proxy rotation or rate-limit bypass.
    try:
        result = subprocess.run(['curl','--fail','--silent','--show-error','--location','--max-time','15',url],capture_output=True,timeout=18,check=True)
        raw = result.stdout
        if xml:
            return ET.fromstring(raw)
        text = raw.decode('utf-8')
        if text.startswith('monthlyCallback('):
            text = text[len('monthlyCallback('):].rstrip().removesuffix(';').removesuffix(')')
        return json.loads(text)
    except Exception:
        raise RuntimeError(str(error)) from None


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
    if stamp > now or (now-stamp).total_seconds() > 60*86400 or not link.startswith(('https://', 'http://')):
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




def price_features(bars, now):
    # Completed sessions only: live bars cannot masquerade as closing returns.
    bars = sorted({d: p for d, p in bars if d < now.date().isoformat() and number(p) is not None and p > 0}.items())
    if len(bars) < 11 or (now.date()-dt.date.fromisoformat(bars[-1][0])).days > 7:
        raise RuntimeError('insufficient or stale completed price sessions')
    bars = bars[-16:]
    values = [p for _, p in bars]
    result = {'asOf': bars[-1][0], 'sessions': len(bars)-1, 'dates': [d for d, _ in bars],
              'nearHigh': values[-1]/max(values)*100}
    for period in (3, 5, 10, 15):
        result['return'+str(period)] = (values[-1]/values[-period-1]-1)*100 if len(values)>period else None
    return result


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
    params = {'secid': code if '.' in code else '90.'+code, 'klt': 101, 'fqt': 0, 'lmt': 40, 'beg': (now.date()-dt.timedelta(days=100)).strftime('%Y%m%d'), 'end': now.strftime('%Y%m%d'), 'fields1': 'f1,f2,f3,f4,f5,f6', 'fields2': 'f51,f52,f53,f54,f55,f56'}
    j = request('https://push2his.eastmoney.com/api/qt/stock/kline/get?'+urllib.parse.urlencode(params))
    rows = [x.split(',') for x in (j.get('data') or {}).get('klines') or []]
    result = price_features([(p[0], float(p[2])) for p in rows], now)
    volume = [number(p[5]) for p in rows if p[0] in result['dates']]
    if len(volume) >= 10 and all(v is not None for v in volume) and sum(volume[-10:-5]) > 0:
        result['volumeRatio5'] = sum(volume[-5:])/sum(volume[-10:-5])
    result['source'] = '东方财富板块日线'
    return result


def resolve_board(theme):
    for name in theme['boards']:
        j = request('https://searchapi.eastmoney.com/api/suggest/get?'+urllib.parse.urlencode({'input': name, 'type': 14, 'count': 10}))
        for row in (j.get('QuotationCodeTable') or {}).get('Data') or []:
            if row.get('Name') == name and re.fullmatch(r'BK\d+', row.get('Code', '')):
                return {'code': row['Code'], 'name': name}
    raise RuntimeError('no exact sector code match')


def flow_features(rows, dates):
    unique = {r['date']: r for r in rows if r['date'] in dates and number(r.get('net')) is not None and number(r.get('ratio')) is not None}
    valid = [unique[d] for d in dates if d in unique][-LOOKBACK:]
    if len(valid) < 10 or not set(dates[-5:]).issubset(unique):
        raise RuntimeError('历史资金不足10个交易日或缺少最近交易日')
    result = {'rows': valid, 'sessions': len(valid), 'asOf': valid[-1]['date'], 'positive5': sum(r['net'] > 0 for r in valid[-5:]), 'days5': len(valid[-5:])}
    for n in (3, 5, 10, 15):
        result['net'+str(n)] = sum(unique[d]['net'] for d in dates[-n:]) if len(dates)>=n and set(dates[-n:]).issubset(unique) else None
    recent = sum(r['ratio'] for r in valid[-3:])/3
    prior = sum(r['ratio'] for r in valid[-8:-3])/len(valid[-8:-3])
    result.update(ratio3=recent, acceleration=recent-prior)
    return result


def historical_flow(code, dates):
    params = {'secid': '90.'+code, 'lmt': 40, 'klt': 101, 'fields1': 'f1,f2,f3,f7', 'fields2': ','.join('f'+str(i) for i in range(51,66))}
    j = request('https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?'+urllib.parse.urlencode(params))
    rows = [x.split(',') for x in (j.get('data') or {}).get('klines') or []]
    return flow_features([{'date': x[0], 'net': number(x[1]), 'ratio': number(x[6])} for x in rows if len(x)>=7], dates)


def historical_news(theme, now, start):
    items, seen = [], set()
    for page in range(1, 4):
        param = {'uid': '', 'keyword': theme['words'][0], 'type': ['cmsArticleWebOld'], 'client': 'web', 'clientType': 'web', 'clientVersion': 'curr', 'param': {'cmsArticleWebOld': {'searchScope': 'default', 'sort': 'default', 'pageIndex': page, 'pageSize': 50, 'preTag': '', 'postTag': ''}}}
        j = request('https://search-api-web.eastmoney.com/search/jsonp?'+urllib.parse.urlencode({'cb': 'monthlyCallback', 'param': json.dumps(param, ensure_ascii=False)}))
        rows = (j.get('result') or {}).get('cmsArticleWebOld')
        if not isinstance(rows, list):
            raise RuntimeError('新闻搜索响应异常')
        fresh = 0
        for r in rows:
            item = news_item(r.get('title', ''), 'https://finance.eastmoney.com/a/'+str(r.get('code', ''))+'.html', r.get('date', ''), r.get('mediaName') or '东财资讯搜索', 'mixed', now)
            if item and item['publishedAt'][:10] >= start and item['id'] not in seen:
                seen.add(item['id']); items.append(item); fresh += 1
        if len(rows)<50 or not fresh:
            break
    return items


def market_calendar(now):
    try:
        p = domestic_price('1.000001', now)
    except Exception:
        j = request('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh000001,day,,,40,qfq')
        data = (j.get('data') or {}).get('sh000001') or {}
        p = price_features([(x[0], float(x[2])) for x in data.get('day', data.get('qfqday', []))], now)
        p['source'] = '腾讯上证指数日线'
    if p['sessions'] < LOOKBACK:
        raise RuntimeError('无法确认最近15个交易日')
    return p


def hot_concepts(now, last_session):
    # Current Top 100 is an explicitly limited snapshot, not historical popularity.
    params = {'pn': 1, 'pz': 100, 'po': 1, 'np': 1, 'fltt': 2, 'invt': 2, 'fid': 'f3', 'fs': 'm:90+t:3', 'fields': 'f12,f14,f3,f62,f104,f105,f124'}
    j = request('https://push2.eastmoney.com/api/qt/clist/get?'+urllib.parse.urlencode(params))
    raw = (j.get('data') or {}).get('diff') or []
    raw = list(raw.values()) if isinstance(raw, dict) else raw
    rows = []
    for r in raw:
        ts = number(r.get('f124'))
        if not ts:
            continue
        date = dt.datetime.fromtimestamp(ts, TZ).date().isoformat()
        if date not in {last_session, now.date().isoformat()}:
            continue
        if number(r.get('f3')) is not None:
            rows.append({'code': r['f12'], 'name': r['f14'], 'change': number(r['f3']), 'flow': number(r.get('f62')), 'up': number(r.get('f104')), 'down': number(r.get('f105')), 'asOf': date})
    if not rows:
        raise RuntimeError('无有效日期的概念行情快照')
    return rows


def board_changes(now):
    j = request('https://push2ex.eastmoney.com/getAllBKChanges?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wzchanges&pageindex=0&pagesize=5000')
    rows = (j.get('data') or {}).get('allbk')
    if not isinstance(rows, list) or not rows:
        raise RuntimeError('板块异动接口无数据；历史异动不补造')
    # Preserve provider fields for audit; no fake dates or stock-count inference.
    valid = [{**r, 'ct':number(r['ct']), 'u':number(r['u']), 'zjl':number(r['zjl'])} for r in rows if r.get('n') and number(r.get('ct')) is not None and number(r.get('u')) is not None and number(r.get('zjl')) is not None]
    if not valid:
        raise RuntimeError('板块异动字段不可验证')
    return {'observedAt': now.isoformat(), 'basis': '接口当前快照，非15日历史', 'rows': valid}


def theme_heat(theme, concepts, anomalies):
    keys = theme['words'] + theme['boards']
    matching = [r for r in concepts if mentions(r['name'], keys)]
    selected = [r for r in (anomalies or {}).get('rows', []) if mentions(r['n'], keys)]
    bullish = [r for r in matching if r['change'] > 0 and (r['flow'] or 0) > 0]
    breadth = [r['up']/(r['up']+r['down']) for r in matching if r['up'] is not None and r['down'] is not None and r['up']+r['down']>0]
    concept_score = clamp(len(bullish)*15 + (sum(breadth)/len(breadth)*40 if breadth else 0)) if matching else 0
    positive = sum(max(0, r['ct']) for r in selected if r['u']>0 and r['zjl']>0)
    negative = sum(max(0, r['ct']) for r in selected if r['u']<0 or r['zjl']<0)
    anomaly_score = clamp(20*math.log1p(positive)-10*math.log1p(negative)) if selected else 0
    return {'score': round(.5*concept_score+.5*anomaly_score, 1), 'concepts': matching, 'anomalies': selected,
            'conceptScore': round(concept_score, 1), 'anomalyScore': round(anomaly_score, 1),
            'basis': '概念涨幅Top100行情热度代理 + 当前板块异动；没有15日历史热榜',
            'observedAt': (anomalies or {}).get('observedAt'), 'coverage': bool(matching or selected)}


def merge_news(previous, incoming, now, start=None):
    result = {}
    for n in previous+incoming:
        try:
            stamp = dt.datetime.fromisoformat(n['publishedAt'])
            if stamp <= now and now-stamp <= dt.timedelta(days=60) and (not start or stamp.astimezone(TZ).date().isoformat() >= start):
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
    # Recent 3-5 sessions have higher relevance; source breadth is capped.
    dates = latest.get('windowDates', [])
    recent_start = dates[-5] if len(dates)>=5 else now.date().isoformat()
    strength = sum(1 if n['publishedAt'][:10]>=recent_start else .4 for n in positive)
    news_score = clamp(strength*12 + min(15, len(evidence)*2) + min(15, len({n['source'] for n in evidence})*5) - len(negative)*8)
    flow = latest.get('flowHistory')
    flow_score = clamp(35+flow['ratio3']*4+flow['acceleration']*3+30*flow['positive5']/flow['days5']) if flow else 0
    foreign, domestic = latest.get('foreign'), latest.get('domestic')
    foreign_score = clamp(40+foreign['return3']*3+foreign['return5']*2+(foreign.get('return15') or 0)*.3) if foreign else 0
    domestic_score = clamp(35+domestic['return3']*3+domestic['return5']*2+domestic.get('relative5', 0)*3+clamp((domestic.get('volumeRatio5',1)-1)*15,-15,15)) if domestic else 0
    heat = latest.get('heat') or {}
    long_move = (domestic.get('return15') if domestic.get('return15') is not None else domestic['return10']) if domestic else 0
    penalty = min(35,max(0,long_move-10)*1.5+max(0,domestic['return5']-5)*2) if domestic else 0
    if domestic and flow and domestic['return5']>0 and flow['net5']<0:
        penalty = min(45,penalty+8)
    factors = {'news': round(news_score,1), 'flow': round(flow_score,1), 'heat': heat.get('score',0), 'domestic': round(domestic_score,1), 'foreign': round(foreign_score,1)}
    weights = {'flow':25,'news':25,'heat':20,'domestic':15,'foreign':15}
    coverage = {'news':bool(evidence),'flow':flow is not None,'heat':bool(heat.get('coverage')),'domestic':domestic is not None,'foreign':foreign is not None}
    score = round(clamp(sum(factors[k]*w/100 for k,w in weights.items())-penalty),1)
    # Deployment age never gates confirmation. Historical inputs must cover >=10 sessions.
    eligible = sum(coverage.values())>=3 and coverage['domestic'] and coverage['news'] and bool(positive) and score>=55 and penalty<20 and domestic.get('sessions',0)>=10 and len(dates)==15
    return {**theme,'score':score,'eligible':eligible,'coverage':coverage,'factors':factors,'weights':weights,
            'overheatPenalty':round(penalty,1),'positiveNews':len(positive),'riskNews':len(negative),
            'observedDays':len(days),'historicalSessions':domestic.get('sessions',0) if domestic else 0,
            'windowDates':dates,'flowPositiveDays':flow['positive5'] if flow else 0,'flowDays':flow['days5'] if flow else 0,
            'flow':flow['rows'][-1]['net'] if flow else None,'flowHistory':flow,'foreign':foreign,'domestic':domestic,
            'heat':heat,'evidence':sorted(evidence,key=lambda n:n['publishedAt'],reverse=True)[:12],
            'newsCoverage':{'count':len(evidence),'earliest':min((n['publishedAt'] for n in evidence),default=None),'complete':False},
            'missing':[k for k,v in coverage.items() if not v],
            'stage':'涨幅偏高或资金背离' if penalty>=20 else '可确认' if eligible else '证据不足，供比较'}


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
    historical_cache = read_json(directory/'historical-cache.json', {})
    news, failures, source_status = [], [], []
    observations = {t['id']: {} for t in THEMES}
    def status(label, ok, error=None):
        source_status.append({'source':label,'ok':ok,'checkedAt':now.isoformat()})
        if error:
            failures.append(label+': '+str(error)[:180])
    try:
        benchmark = market_calendar(now)
        dates = benchmark['dates'][-LOOKBACK:]
        status('交易日历与大盘基准', True)
    except Exception as exc:
        benchmark, dates = None, []
        status('交易日历与大盘基准', False, exc)
    start = dates[0] if dates else (now.date()-dt.timedelta(days=45)).isoformat()
    boards, concepts, anomalies = {}, [], None
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        jobs = {pool.submit(fetch_news,f,now):('rss',f[0]) for f in FEEDS}
        for t in THEMES:
            jobs[pool.submit(foreign_price,t['proxy'],now)] = ('foreign',t['id'])
            jobs[pool.submit(resolve_board,t)] = ('mapping',t['id'])
            jobs[pool.submit(historical_news,t,now,start)] = ('news',t['id'])
        if dates:
            jobs[pool.submit(hot_concepts,now,dates[-1])] = ('concepts','概念行情热度代理')
        jobs[pool.submit(board_changes,now)] = ('anomalies','当前板块异动')
        for job in concurrent.futures.as_completed(jobs):
            kind,label = jobs[job]
            try:
                data = job.result()
                if kind in ('rss','news'):
                    news.extend(data)
                elif kind=='mapping':
                    boards[label] = data
                elif kind=='concepts':
                    concepts = data
                elif kind=='anomalies':
                    anomalies = data
                else:
                    observations[label][kind] = data
                status(label+' '+kind, True)
            except Exception as exc:
                status(label+' '+kind, False, exc)
        jobs = {}
        for t in THEMES:
            ident = t['id']
            observations[ident]['windowDates'] = dates
            observations[ident]['heat'] = theme_heat(t,concepts,anomalies)
            if ident in boards:
                board = boards[ident]
                observations[ident]['representativeBoard'] = board
                # Independent jobs: one endpoint failure cannot suppress the other.
                jobs[pool.submit(domestic_price,board['code'],now)] = ('domestic',ident)
                if dates:
                    jobs[pool.submit(historical_flow,board['code'],dates)] = ('flowHistory',ident)
        for job in concurrent.futures.as_completed(jobs):
            kind,label = jobs[job]
            try:
                data = job.result()
                if kind=='domestic' and dates:
                    if data['asOf']!=dates[-1]:
                        raise RuntimeError('国内行情未覆盖最近交易日')
                    data['relative5'] = data['return5']-benchmark['return5']
                observations[label][kind] = data
                historical_cache.setdefault(label,{})[kind] = {'data':data,'capturedAt':now.isoformat(),'boardCode':boards[label]['code']}
                status(label+' '+kind, True)
            except Exception as exc:
                cached = historical_cache.get(label,{}).get(kind,{})
                data = cached.get('data')
                # Reuse only actual history covering the identical latest session.
                # Never reuse yesterday's incomplete window as today's history.
                if data and dates and data.get('asOf')==dates[-1] and cached.get('boardCode')==boards[label]['code']:
                    try:
                        if kind=='flowHistory':
                            data = flow_features(data['rows'],dates)
                        elif data.get('dates') != benchmark['dates']:
                            raise ValueError('cached calendar differs')
                        observations[label][kind] = {**data,'cached':True,'capturedAt':cached['capturedAt']}
                        status(label+' '+kind+'（有效历史缓存）', True)
                        failures.append(label+' '+kind+': 本次接口失败，使用截至'+data['asOf']+'的已验证历史缓存')
                        continue
                    except (KeyError,ValueError,RuntimeError):
                        pass
                status(label+' '+kind, False, exc)
    merged = merge_news(previous.get('news',[]),news,now,start)
    current = {'date':now.date().isoformat(),'at':now.isoformat(),'themes':observations,'modelVersion':VERSION}
    days = daily_observations(history,current)
    ranked = sorted([score_theme(t,merged,days,now) for t in THEMES],key=lambda t:(-t['score'],t['id']))
    for row in ranked:
        row['representativeBoard'] = boards.get(row['id'])
    current['leader'] = next((r['id'] for r in ranked if r['eligible']),None)
    days = daily_observations(history,current)
    state = choose_month(ranked,previous.get('monthState',{}),days,now)
    payload = {'schemaVersion':1,'modelVersion':VERSION,'generatedAt':now.isoformat(),'month':now.strftime('%Y-%m'),
               'monthState':state,'ranked':ranked,'news':merged,'sourceStatus':source_status,'errors':failures,
               'observedDays':len(days),'lookback':{'targetSessions':15,'dates':dates,'start':dates[0] if dates else None,'end':dates[-1] if dates else None},
               'benchmark':benchmark,'method':'回溯15个交易日，近3/5日优先；当前异动与题材快照不冒充历史；历史补采仅支持本次判断'}
    usable = bool(news or any(o.get('domestic') or o.get('foreign') or o.get('flowHistory') for o in observations.values()))
    payload['usable'] = usable
    stamp = now.strftime('%Y-%m-%dT%H%M%S')
    write_json(directory/'runs'/f'{stamp}.json',payload)
    if usable:
        write_json(directory/'historical-cache.json',historical_cache)
        write_json(directory/'history.json',days)
        write_json(directory/'months'/f'{payload["month"]}.json',state)
        write_json(directory/'latest.json',payload)
    else:
        raise RuntimeError('all sources unavailable; kept last successful latest.json')
    print(json.dumps({'lookback':payload['lookback'],'selected':state['selectedId'],'news':len(merged),'failures':failures},ensure_ascii=False))
    return payload


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    collect(args.root, dt.datetime.now(TZ))
