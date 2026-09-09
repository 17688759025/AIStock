import datetime as dt
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('premarket', Path(__file__).parents[1] / 'scripts/collect_premarket_candidates.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


class PremarketTests(unittest.TestCase):
    def test_deadline(self):
        self.assertEqual(p.observation_status(dt.datetime(2026, 9, 9, 9, 24, 59, tzinfo=p.TZ)), 'premarket')
        for hour, minute in [(9, 25), (13, 7)]:
            self.assertEqual(p.observation_status(dt.datetime(2026, 9, 9, hour, minute, tzinfo=p.TZ)), 'delayed')

    def test_previous_session_not_today_or_weekend(self):
        now = dt.datetime(2026, 9, 7, 8, 50, tzinfo=p.TZ)
        calls = []
        def request(url, params):
            calls.append(params)
            if 'fqkline' in url:
                return {'data': {'sh000001': {'day': [['2026-09-03'], ['2026-09-04'], ['2026-09-07']]}}}
            return {'data': {'qdate': 20260904, 'pool': []}}
        with patch.object(p, 'request_json', request):
            rows, date = p.fetch_limit_pool(now)
        self.assertEqual(date, '20260904')
        self.assertEqual(calls[-1]['date'], '20260904')
        self.assertEqual(rows, [])

    def test_wrong_limit_date_rejected(self):
        now = dt.datetime(2026, 9, 9, 8, 50, tzinfo=p.TZ)
        with patch.object(p, 'previous_trading_date', return_value=dt.date(2026, 9, 8)), patch.object(p, 'request_json', return_value={'data': {'qdate': 20260909, 'pool': []}}):
            with self.assertRaises(RuntimeError):
                p.fetch_limit_pool(now)

    def test_future_announcements_excluded(self):
        now = dt.datetime(2026, 9, 9, 8, 50, tzinfo=p.TZ)
        rows = [{'title': '重大合同', 'display_time': '2026-09-09 10:00:00', 'codes': [{'stock_code': '600001'}]}]
        with patch.object(p, 'request_json', return_value={'data': {'list': rows}}):
            self.assertEqual(p.fetch_announcements(now), ([], {}))


if __name__ == '__main__':
    unittest.main()
