"""
Tests for the newly added backend features:
- Partial PUT /settings (exclude_unset preserves googleApiKey, fcRate)
- Manager commission %, dashboard math + opening/closing balances, periodStart
- Reports P&L now includes commission
- POST /periods/close snapshot + carry-forward
- POST /reset danger zone requires ?confirm=YES and preserves googleApiKey + fcRate
"""
import os
import datetime as dt
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://vocash-accounting.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


# ---------- helpers ----------
def _reset(confirm=True):
    if confirm:
        return requests.post(f"{API}/reset", params={"confirm": "YES"}, timeout=30)
    return requests.post(f"{API}/reset", timeout=30)


def _set_settings(payload):
    return requests.put(f"{API}/settings", json=payload, timeout=15)


def _get_settings():
    r = requests.get(f"{API}/settings", timeout=15)
    r.raise_for_status()
    return r.json()


@pytest.fixture(scope="module", autouse=True)
def clean_state():
    # Prime a Gemini key + fc rate so we can verify preservation
    _reset(confirm=True)
    _set_settings({"googleApiKey": "TEST_KEY_PRESERVE", "fcRate": 2500.0})
    yield
    _reset(confirm=True)
    # Explicitly clear the preserved googleApiKey so downstream test modules
    # that assume "no key" continue to work.
    _set_settings({"googleApiKey": "", "fcRate": 1.0})


# ------------------------------------------------------------------
# 1. Partial PUT /settings must not wipe other fields (exclude_unset)
# ------------------------------------------------------------------
class TestPartialSettingsUpdate:
    def test_partial_update_preserves_other_fields(self):
        # Baseline set in fixture: googleApiKey=TEST_KEY_PRESERVE, fcRate=2500
        r = _set_settings({"managerCommissionPct": 15})
        assert r.status_code == 200, r.text

        s = _get_settings()
        assert s["managerCommissionPct"] == 15
        assert s["googleApiKey"] == "TEST_KEY_PRESERVE", "googleApiKey wiped by partial PUT"
        assert s["fcRate"] == 2500.0, "fcRate wiped by partial PUT"

    def test_partial_update_only_fcrate(self):
        r = _set_settings({"fcRate": 2600.0})
        assert r.status_code == 200
        s = _get_settings()
        assert s["fcRate"] == 2600.0
        assert s["googleApiKey"] == "TEST_KEY_PRESERVE"
        assert s["managerCommissionPct"] == 15  # from previous test still present


# ------------------------------------------------------------------
# 2. Dashboard math + P&L commission
# ------------------------------------------------------------------
class TestDashboardMathWithCommission:
    @classmethod
    def setup_class(cls):
        # fresh slate but keep googleApiKey + fcRate
        _reset(confirm=True)
        _set_settings({"googleApiKey": "TEST_KEY_PRESERVE", "fcRate": 2500.0,
                       "managerCommissionPct": 20, "currentPeriodStart": "2020-01-01"})
        today = dt.date.today().isoformat()
        # sale $200
        requests.post(f"{API}/sales", json={"date": today, "amount": 200, "currency": "USD", "rate": 1.0}).raise_for_status()
        # bill $80 - needs a supplier first
        sup = requests.post(f"{API}/suppliers", json={"name": "TEST_S1"}).json()
        cls.supplier_id = sup["id"]
        requests.post(f"{API}/bills", json={"supplierId": cls.supplier_id, "date": today, "amount": 80,
                                            "currency": "USD", "rate": 1.0, "paymentType": "credit"}).raise_for_status()
        # drawing $10
        requests.post(f"{API}/payments", json={"date": today, "amount": 10, "currency": "USD",
                                               "rate": 1.0, "type": "drawing", "partnerName": "TEST_P"}).raise_for_status()

    def test_dashboard_all_fields_present(self):
        r = requests.get(f"{API}/dashboard", timeout=15)
        assert r.status_code == 200
        d = r.json()
        for key in ("openingBalance", "openingCash", "openingInventory",
                    "closingBalance", "managerCommissionPct", "commission",
                    "netProfit", "periodStart", "totalSales", "totalPurchases",
                    "grossProfit", "drawings"):
            assert key in d, f"dashboard missing field {key}"

    def test_dashboard_numeric_math(self):
        d = requests.get(f"{API}/dashboard", timeout=15).json()
        assert d["totalSales"] == 200
        assert d["totalPurchases"] == 80
        assert d["grossProfit"] == 120
        assert d["managerCommissionPct"] == 20
        assert d["commission"] == 24  # 120 * 0.20
        assert d["drawings"] == 10
        assert d["netProfit"] == 86  # 120 - 24 - 10

    def test_pnl_report_includes_commission(self):
        r = requests.get(f"{API}/reports/pnl", timeout=15)
        assert r.status_code == 200
        p = r.json()
        assert "commission" in p and "managerCommissionPct" in p
        assert p["revenue"] == 200
        assert p["cogs"] == 80
        assert p["grossProfit"] == 120
        assert p["commission"] == 24
        assert p["managerCommissionPct"] == 20
        assert p["drawings"] == 10
        assert p["netProfit"] == 86

    def test_suppliers_count_regression(self):
        d = requests.get(f"{API}/dashboard", timeout=15).json()
        assert d["suppliers"] == 1


# ------------------------------------------------------------------
# 3. Close period flow
# ------------------------------------------------------------------
class TestClosePeriod:
    @classmethod
    def setup_class(cls):
        _reset(confirm=True)
        _set_settings({"googleApiKey": "TEST_KEY_PRESERVE", "fcRate": 2500.0,
                       "managerCommissionPct": 20, "currentPeriodStart": "2020-01-01",
                       "openingCash": 0.0, "openingInventory": 0.0})
        today = dt.date.today().isoformat()
        requests.post(f"{API}/sales", json={"date": today, "amount": 200, "currency": "USD", "rate": 1.0}).raise_for_status()
        sup = requests.post(f"{API}/suppliers", json={"name": "TEST_S_close"}).json()
        requests.post(f"{API}/bills", json={"supplierId": sup["id"], "date": today, "amount": 80,
                                            "currency": "USD", "rate": 1.0, "paymentType": "credit"}).raise_for_status()
        requests.post(f"{API}/payments", json={"date": today, "amount": 10, "currency": "USD",
                                               "rate": 1.0, "type": "drawing", "partnerName": "TEST"}).raise_for_status()

    def test_close_period_creates_snapshot(self):
        # Before close - snapshot dashboard cash for later comparison
        d_before = requests.get(f"{API}/dashboard", timeout=15).json()
        prev_cash = d_before["cash"]

        r = requests.post(f"{API}/periods/close", json={"actualStock": 500, "notes": "end of Q1"}, timeout=15)
        assert r.status_code == 200, r.text
        period = r.json()
        # Summary fields
        for k in ("startDate", "endDate", "openingInventory", "openingCash",
                  "totalSales", "totalPurchases", "grossProfit",
                  "managerCommissionPct", "commission", "drawings",
                  "supplierPayments", "netProfit", "closingInventory", "closingCash"):
            assert k in period, f"period snapshot missing {k}"
        assert period["closingInventory"] == 500
        assert period["totalSales"] == 200
        assert period["totalPurchases"] == 80
        assert period["commission"] == 24
        assert period["netProfit"] == 86
        assert period["notes"] == "end of Q1"

        # GET /periods lists it
        periods = requests.get(f"{API}/periods", timeout=15).json()
        assert isinstance(periods, list) and len(periods) >= 1
        assert any(p.get("notes") == "end of Q1" for p in periods)

        # An inventoryChecks record was created
        inv = requests.get(f"{API}/inventory", timeout=15).json()
        assert any(float(x.get("actualStock", 0)) == 500 for x in inv), "closing inventory record not created"

        # settings bumped
        s = _get_settings()
        today = dt.date.today()
        expected_next = (today + dt.timedelta(days=1)).isoformat()
        assert s["currentPeriodStart"] == expected_next, f"expected currentPeriodStart={expected_next}, got {s['currentPeriodStart']}"
        assert s["openingInventory"] == 500
        assert s["openingCash"] == prev_cash
        # gemini key preserved through close
        assert s["googleApiKey"] == "TEST_KEY_PRESERVE"

    def test_dashboard_after_close_new_period(self):
        d = requests.get(f"{API}/dashboard", timeout=15).json()
        # No new transactions after close (all data is dated <= today, period starts tomorrow)
        assert d["totalSales"] == 0
        assert d["totalPurchases"] == 0
        assert d["drawings"] == 0
        assert d["openingInventory"] == 500
        # openingBalance = openingCash + openingInventory
        expected_open = round(d["openingCash"] + d["openingInventory"], 2)
        assert d["openingBalance"] == expected_open
        assert d["closingBalance"] == expected_open, "no txns → closing must equal opening"


# ------------------------------------------------------------------
# 4. Reset endpoint
# ------------------------------------------------------------------
class TestResetEndpoint:
    def test_reset_requires_confirm(self):
        r = _reset(confirm=False)
        assert r.status_code == 400, f"expected 400 without confirm, got {r.status_code}"

    def test_reset_preserves_google_key_and_fcrate(self):
        # Seed a supplier + set commission to non-zero to see it wiped
        _set_settings({"googleApiKey": "TEST_KEY_PRESERVE", "fcRate": 2500.0, "managerCommissionPct": 15})
        requests.post(f"{API}/suppliers", json={"name": "TEST_will_die"})

        r = _reset(confirm=True)
        assert r.status_code == 200, r.text

        # All collections empty
        for path in ("suppliers", "bills", "sales", "payments", "inventory", "periods"):
            j = requests.get(f"{API}/{path}", timeout=15).json()
            assert isinstance(j, list)
            assert len(j) == 0, f"{path} not empty after reset: {j}"

        # Dashboard zeros
        d = requests.get(f"{API}/dashboard", timeout=15).json()
        assert d["totalSales"] == 0
        assert d["totalPurchases"] == 0
        assert d["grossProfit"] == 0
        assert d["commission"] == 0
        assert d["netProfit"] == 0
        assert d["drawings"] == 0
        assert d["suppliers"] == 0

        # Preserved settings
        s = _get_settings()
        assert s["googleApiKey"] == "TEST_KEY_PRESERVE", "googleApiKey NOT preserved after reset"
        assert s["fcRate"] == 2500.0, "fcRate NOT preserved after reset"
        # Reset fields
        assert s["managerCommissionPct"] == 0.0
        assert s["openingInventory"] == 0.0
        assert s["openingCash"] == 0.0
        assert s["currentPeriodStart"] == "1970-01-01"
