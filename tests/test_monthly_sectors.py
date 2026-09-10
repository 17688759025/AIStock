import datetime as dt
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import tempfile

spec = importlib.util.spec_from_file_location('monthly', Path(__file__).parents[1]/'scripts/collect_monthly_sectors.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = dt.datetime(2026, 9, 9, 16, tzinfo=m.TZ)


class MonthlyTests(unittest.TestCase):
    def test_english_keywords_do_not_match_inside_other_words(self):
        self.assertFalse(m.mentions('Goldman bank', ['gold', 'ban']))
        self.assertTrue(m.mentions('Gold price hike', ['gold']))

    def test_news_dedup_and_future_rejection(self):
        args = ('半导体涨价', 'https://example.com/a', 'Wed, 09 Sep 2026 00:00:00 +0000', '来源', 'domestic', NOW)
        item = m.news_item(*args)
        self.assertEqual(len(m.merge_news([item], [dict(item, source='转载')], NOW)), 1)
        self.assertIsNone(m.news_item(args[0], args[1], 'Wed, 09 Sep 2026 20:00:00 +0000', *args[3:]))

    def test_intraday_refresh_not_multiple_days_or_sum_of_flows(self):
        old = {'date': '2026-09-09', 'themes': {'gold': {'flow': 10}}}
        new = {'date': '2026-09-09', 'themes': {'gold': {'flow': 20}}}
        days = m.daily_observations([old], new)
        self.assertEqual(len(days), 1)
        self.assertEqual(days[0]['themes']['gold']['flow'], 20)

    def test_missing_data_cannot_confirm_and_overheat_lowers_score(self):
        t = m.THEMES[2]
        days = [{'date': '2026-09-09', 'themes': {}}]
        missing = m.score_theme(t, [], days, NOW)
        self.assertFalse(missing['eligible'])
        self.assertEqual(missing['score'], 0)
        news = [m.news_item('半导体涨价'+str(i), 'https://example.com/'+str(i), 'Wed, 09 Sep 2026 00:00:00 +0000', '来源'+str(i), 'domestic', NOW) for i in range(5)]
        dates = [(NOW.date()-dt.timedelta(days=i)).isoformat() for i in range(15,0,-1)]
        rows = [{'date':d,'net':100,'ratio':5} for d in dates]
        data = {'flowHistory':m.flow_features(rows,dates),'windowDates':dates,
                'heat':{'score':90,'coverage':True},
                'foreign':{'return3':2,'return5':5,'return15':8},
                'domestic':{'return3':2,'return5':3,'return10':5,'return15':8,'sessions':15}}
        # First deployment can qualify from genuine historical observations.
        days = [{'date': '2026-09-09', 'themes': {t['id']: data}}]
        normal = m.score_theme(t, news, days, NOW)
        self.assertTrue(normal['eligible'])
        data['domestic'] = {'return3':8,'return5':15,'return10':25,'return15':40,'sessions':15}
        hot = m.score_theme(t, news, days, NOW)
        self.assertLess(hot['score'], normal['score'])
        self.assertFalse(hot['eligible'])

    def test_month_switch_requires_three_dates(self):
        a = {'id': 'a', 'score': 60, 'eligible': True}
        b = {'id': 'b', 'score': 80, 'eligible': True}
        state = {'month': '2026-09', 'selectedId': 'a', 'events': []}
        days = [{'date': '2026-09-09', 'leader': 'b'}]
        self.assertEqual(m.choose_month([b, a], state, days, NOW)['selectedId'], 'a')
        days = [{'date': '2026-09-0'+str(i), 'leader': 'b'} for i in [7, 8, 9]]
        self.assertEqual(m.choose_month([b, a], state, days, NOW)['selectedId'], 'b')

    def test_prices_exclude_current_session(self):
        bars = [( (NOW.date()-dt.timedelta(days=25-i)).isoformat(), 100+i) for i in range(26)]
        prices = m.price_features(bars, NOW)
        self.assertEqual(prices['asOf'], '2026-09-08')
        self.assertEqual(prices['sessions'], 15)
        self.assertNotIn('return20',prices)
        self.assertAlmostEqual(prices['return15'],(124/109-1)*100)

    def test_flow_filters_future_dates_and_requires_history(self):
        dates = [f'2026-08-{i:02}' for i in range(10,25)]
        rows = [{'date':d,'net':10,'ratio':1} for d in dates]+[{'date':'2026-09-09','net':99999,'ratio':99}]
        flow = m.flow_features(rows,dates)
        self.assertEqual(flow['net15'],150)
        with self.assertRaises(RuntimeError):
            m.flow_features(rows[:2],dates)

    def test_news_uses_window_start_not_deployment_date(self):
        n = m.news_item('半导体涨价','https://example.com/a','2026-08-25T10:00:00+08:00','来源','mixed',NOW)
        self.assertEqual(len(m.merge_news([], [n], NOW, '2026-08-20')),1)
        self.assertEqual(len(m.merge_news([], [n], NOW, '2026-09-01')),0)

    def test_heat_never_invents_historical_continuity(self):
        heat = m.theme_heat(m.THEMES[2],[],None)
        self.assertEqual(heat['score'],0)
        self.assertFalse(heat['coverage'])
        self.assertNotIn('history',heat)

    def test_anomaly_string_numbers_are_normalized(self):
        with patch.object(m,'request',return_value={'data':{'allbk':[{'n':'半导体','ct':'20','u':'1.2','zjl':'1000'}]}}):
            raw = m.board_changes(NOW)
        heat = m.theme_heat(m.THEMES[2],[],raw)
        self.assertGreater(heat['score'],0)
        raw['rows'][0]['zjl'] = -100
        self.assertEqual(m.theme_heat(m.THEMES[2],[],raw)['score'],0)

    def test_collection_keeps_domestic_when_flow_fails(self):
        dates = [f'2026-08-{i:02}' for i in range(10,26)]
        price = {'dates':dates,'sessions':15,'asOf':dates[-1],'return3':1,'return5':2,'return10':3,'return15':4}
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(m,'market_calendar',return_value=price), \
             patch.object(m,'resolve_board',return_value={'code':'BK1036','name':'半导体'}), \
             patch.object(m,'domestic_price',return_value=dict(price)), \
             patch.object(m,'foreign_price',return_value=dict(price)), \
             patch.object(m,'historical_flow',side_effect=RuntimeError('simulated flow failure')), \
             patch.object(m,'fetch_news',return_value=[]), \
             patch.object(m,'historical_news',return_value=[]), \
             patch.object(m,'hot_concepts',return_value=[]), \
             patch.object(m,'board_changes',side_effect=RuntimeError('missing')), \
             patch('builtins.print'):
            p = m.collect(Path(temp), NOW)
            self.assertEqual(len(p['lookback']['dates']),15)
            self.assertTrue(all(r['coverage']['domestic'] for r in p['ranked']))
            self.assertTrue(all(not r['coverage']['flow'] for r in p['ranked']))
            self.assertEqual(len(p['monthState']['events']),0)


if __name__ == '__main__':
    unittest.main()
