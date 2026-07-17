"""Vocash Accounting Backend API Tests

Covers:
- Health, Settings (CRUD + test-key)
- Suppliers, Bills, Sales, Payments, Inventory
- Dashboard, Reports (PNL, BS, TB)
- AI endpoints (401 expected without key)
- No `_id` leakage
"""
import pytest
import requests


class TestHealth:
    def test_root(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/")
        assert r.status_code == 200
        data = r.json()
        assert data.get("status") == "ok"
        assert data.get("app") == "vocash-accounting"
        assert "_id" not in data


# ----------- Settings -----------
class TestSettings:
    def test_get_settings_returns_object(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/settings")
        assert r.status_code == 200
        d = r.json()
        assert "googleApiKey" in d
        assert "fcRate" in d
        assert "_id" not in d

    def test_put_and_get_settings(self, api_client, base_url):
        payload = {"googleApiKey": "test", "fcRate": 2500}
        r = api_client.put(f"{base_url}/api/settings", json=payload)
        assert r.status_code == 200
        d = r.json()
        assert d["googleApiKey"] == "test"
        assert d["fcRate"] == 2500

        r = api_client.get(f"{base_url}/api/settings")
        assert r.status_code == 200
        d = r.json()
        assert d["googleApiKey"] == "test"
        assert d["fcRate"] == 2500
        assert "_id" not in d

    def test_test_key_401_when_no_key(self, api_client, base_url):
        # Clear settings key first
        api_client.put(f"{base_url}/api/settings", json={"googleApiKey": "", "fcRate": 2500})
        r = api_client.post(f"{base_url}/api/settings/test-key")
        assert r.status_code == 401
        assert "Missing Google Gemini API key" in r.json().get("detail", "")

    def test_test_key_400_with_invalid_key(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/settings/test-key",
            headers={"x-gemini-api-key": "INVALID_KEY_ABC"},
        )
        # Either 400 (gemini test failed) is expected. Not 200.
        assert r.status_code in (400, 401, 403)


# ----------- Suppliers -----------
@pytest.fixture(scope="module")
def supplier_id(api_client):
    r = api_client.post(
        f"{BASE_URL_MOD}/api/suppliers",
        json={"name": "TEST_Rahim Trading", "phone": "01711"},
    )
    assert r.status_code == 200
    d = r.json()
    assert "_id" not in d
    assert d["name"] == "TEST_Rahim Trading"
    return d["id"]


BASE_URL_MOD = None


@pytest.fixture(scope="session", autouse=True)
def _init_base(base_url):
    global BASE_URL_MOD
    BASE_URL_MOD = base_url


class TestSuppliers:
    def test_create_supplier(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/suppliers",
            json={"name": "TEST_SupplierA", "phone": "0170000"},
        )
        assert r.status_code == 200
        d = r.json()
        assert d["name"] == "TEST_SupplierA"
        assert d["phone"] == "0170000"
        assert "id" in d
        assert "_id" not in d
        # Persist for later delete via list scan
        pytest.supplier_a_id = d["id"]

    def test_list_suppliers_has_balance_fields(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/suppliers")
        assert r.status_code == 200
        items = r.json()
        assert isinstance(items, list)
        assert len(items) >= 1
        for it in items:
            assert "_id" not in it
            assert "balance" in it
            assert "billsTotal" in it
            assert "paymentsTotal" in it

    def test_get_supplier_by_id(self, api_client, base_url):
        sid = pytest.supplier_a_id
        r = api_client.get(f"{base_url}/api/suppliers/{sid}")
        assert r.status_code == 200
        d = r.json()
        assert "_id" not in d
        assert d["id"] == sid
        assert isinstance(d.get("bills"), list)
        assert isinstance(d.get("payments"), list)

    def test_get_nonexistent_supplier_404(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/suppliers/nonexistent-id-xyz")
        assert r.status_code == 404


# ----------- Bills -----------
class TestBills:
    def test_create_bill_and_balance_updates(self, api_client, base_url):
        sid = pytest.supplier_a_id
        # Baseline balance
        r0 = api_client.get(f"{base_url}/api/suppliers")
        base_balance = next((s["balance"] for s in r0.json() if s["id"] == sid), 0.0)

        r = api_client.post(
            f"{base_url}/api/bills",
            json={
                "supplierId": sid,
                "date": "2026-02-10",
                "amount": 500,
                "currency": "USD",
                "paymentType": "credit",
            },
        )
        assert r.status_code == 200
        d = r.json()
        assert "_id" not in d
        assert d["supplierId"] == sid
        assert d["amount"] == 500
        assert d["currency"] == "USD"
        pytest.bill_id = d["id"]

        # list
        r2 = api_client.get(f"{base_url}/api/bills")
        assert r2.status_code == 200
        assert any(b["id"] == pytest.bill_id for b in r2.json())

        # supplier balance updated
        r3 = api_client.get(f"{base_url}/api/suppliers")
        new_balance = next((s["balance"] for s in r3.json() if s["id"] == sid), 0.0)
        assert round(new_balance - base_balance, 2) == 500.0

    def test_create_bill_cdf_converts(self, api_client, base_url):
        sid = pytest.supplier_a_id
        r = api_client.post(
            f"{base_url}/api/bills",
            json={
                "supplierId": sid,
                "date": "2026-02-11",
                "amount": 2500,
                "currency": "CDF",
                "rate": 2500,
                "paymentType": "cash",
            },
        )
        assert r.status_code == 200
        pytest.bill_cdf_id = r.json()["id"]
        # supplier detail should reflect ~ +$1 additional
        r2 = api_client.get(f"{base_url}/api/suppliers/{sid}")
        assert r2.status_code == 200


# ----------- Sales -----------
class TestSales:
    def test_create_and_list_sale(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/sales",
            json={"date": "2026-02-10", "amount": 300, "currency": "USD"},
        )
        assert r.status_code == 200
        d = r.json()
        assert "_id" not in d
        assert d["amount"] == 300
        pytest.sale_id = d["id"]

        r2 = api_client.get(f"{base_url}/api/sales")
        assert r2.status_code == 200
        assert any(s["id"] == pytest.sale_id for s in r2.json())

    def test_delete_sale(self, api_client, base_url):
        r = api_client.delete(f"{base_url}/api/sales/{pytest.sale_id}")
        assert r.status_code == 200
        r2 = api_client.get(f"{base_url}/api/sales")
        assert not any(s["id"] == pytest.sale_id for s in r2.json())


# ----------- Payments -----------
class TestPayments:
    def test_supplier_payment_reduces_balance(self, api_client, base_url):
        sid = pytest.supplier_a_id
        # Baseline balance
        r0 = api_client.get(f"{base_url}/api/suppliers")
        base_balance = next((s["balance"] for s in r0.json() if s["id"] == sid), 0.0)

        r = api_client.post(
            f"{base_url}/api/payments",
            json={
                "date": "2026-02-12",
                "amount": 100,
                "currency": "USD",
                "type": "supplier_payment",
                "supplierId": sid,
            },
        )
        assert r.status_code == 200
        d = r.json()
        assert "_id" not in d
        assert d["type"] == "supplier_payment"
        pytest.payment_id = d["id"]

        r2 = api_client.get(f"{base_url}/api/suppliers")
        new_balance = next((s["balance"] for s in r2.json() if s["id"] == sid), 0.0)
        assert round(base_balance - new_balance, 2) == 100.0

    def test_drawing_payment_stores_partner(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/payments",
            json={
                "date": "2026-02-12",
                "amount": 50,
                "currency": "USD",
                "type": "drawing",
                "partnerName": "TEST_Partner1",
            },
        )
        assert r.status_code == 200
        d = r.json()
        assert d["type"] == "drawing"
        assert d["partnerName"] == "TEST_Partner1"
        pytest.drawing_id = d["id"]

    def test_list_payments(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/payments")
        assert r.status_code == 200
        items = r.json()
        assert any(p["id"] == pytest.payment_id for p in items)
        assert any(p["id"] == pytest.drawing_id for p in items)
        for p in items:
            assert "_id" not in p

    def test_delete_drawing(self, api_client, base_url):
        r = api_client.delete(f"{base_url}/api/payments/{pytest.drawing_id}")
        assert r.status_code == 200


# ----------- Inventory -----------
class TestInventory:
    def test_expected_endpoint(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/inventory/expected")
        assert r.status_code == 200
        d = r.json()
        assert "expected" in d
        assert "purchasesSince" in d
        assert "salesSince" in d

    def test_create_inventory_variance(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/inventory",
            json={
                "date": "2026-02-13",
                "expectedStock": 500,
                "actualStock": 480,
                "notes": "TEST_audit",
            },
        )
        assert r.status_code == 200
        d = r.json()
        assert "_id" not in d
        assert d["variance"] == -20.0
        pytest.inv_id = d["id"]

    def test_list_and_delete_inventory(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/inventory")
        assert r.status_code == 200
        assert any(i["id"] == pytest.inv_id for i in r.json())

        rd = api_client.delete(f"{base_url}/api/inventory/{pytest.inv_id}")
        assert rd.status_code == 200


# ----------- Dashboard -----------
class TestDashboard:
    def test_dashboard_shape(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/dashboard")
        assert r.status_code == 200
        d = r.json()
        for k in [
            "assets", "liabilities", "netWorth", "cash", "inventoryValue",
            "totalPurchases", "totalSales", "grossProfit", "drawings",
            "supplierPayments", "suppliers", "salesTrend",
        ]:
            assert k in d, f"missing {k}"
        assert isinstance(d["salesTrend"], list)
        # After creating a $500 bill and $100 supplier_payment earlier
        assert d["totalPurchases"] >= 500.0
        assert d["supplierPayments"] >= 100.0


# ----------- Reports -----------
class TestReports:
    def test_pnl(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/reports/pnl")
        assert r.status_code == 200
        d = r.json()
        for k in ["revenue", "cogs", "grossProfit", "drawings", "netProfit"]:
            assert k in d

    def test_balance_sheet(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/reports/balance-sheet")
        assert r.status_code == 200
        d = r.json()
        assert "assets" in d and "liabilities" in d and "equity" in d
        for k in ["cash", "inventory", "total"]:
            assert k in d["assets"]

    def test_trial_balance(self, api_client, base_url):
        r = api_client.get(f"{base_url}/api/reports/trial-balance")
        assert r.status_code == 200
        d = r.json()
        assert isinstance(d.get("debits"), list)
        assert isinstance(d.get("credits"), list)
        assert len(d["debits"]) >= 1
        assert len(d["credits"]) >= 1


# ----------- AI Endpoints (should 401 without key) -----------
class TestAIWithoutKey:
    @pytest.fixture(autouse=True)
    def _clear_key(self, api_client, base_url):
        api_client.put(f"{base_url}/api/settings", json={"googleApiKey": "", "fcRate": 2500})
        yield

    def test_parse_command_401(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/ai/parse-command", json={"text": "Bought $50 rice"})
        assert r.status_code == 401
        assert "Missing Google Gemini API key" in r.json().get("detail", "")

    def test_ocr_receipt_401(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/ai/ocr-receipt",
            json={"imageBase64": "aGVsbG8=", "mimeType": "image/jpeg"},
        )
        assert r.status_code == 401
        assert "Missing Google Gemini API key" in r.json().get("detail", "")

    def test_transcribe_401(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/ai/transcribe",
            json={"audioBase64": "aGVsbG8=", "mimeType": "audio/m4a"},
        )
        assert r.status_code == 401
        assert "Missing Google Gemini API key" in r.json().get("detail", "")


# ----------- Cleanup: delete supplier + bills we created -----------
class TestZCleanup:
    def test_delete_bill(self, api_client, base_url):
        r = api_client.delete(f"{base_url}/api/bills/{pytest.bill_id}")
        assert r.status_code == 200
        r2 = api_client.delete(f"{base_url}/api/bills/{pytest.bill_cdf_id}")
        assert r2.status_code == 200

    def test_delete_supplier_payment(self, api_client, base_url):
        r = api_client.delete(f"{base_url}/api/payments/{pytest.payment_id}")
        assert r.status_code == 200

    def test_delete_supplier(self, api_client, base_url):
        r = api_client.delete(f"{base_url}/api/suppliers/{pytest.supplier_a_id}")
        assert r.status_code == 200
