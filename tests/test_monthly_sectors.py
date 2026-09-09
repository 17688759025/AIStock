import datetime as dt
import importlib.util
from pathlib import Path
import unittest

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
        data = {'flow': 100, 'flowRatio': 10, 'foreign': {'return5': 5, 'return20': 10}, 'domestic': {'return5': 3, 'return20': 8}}
        days = [{'date': '2026-09-0'+str(i), 'themes': {t['id']: data}} for i in [7, 8, 9]]
        normal = m.score_theme(t, news, days, NOW)
        self.assertTrue(normal['eligible'])
        data['domestic'] = {'return5': 15, 'return20': 40}
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


if __name__ == '__main__':
    unittest.main()
