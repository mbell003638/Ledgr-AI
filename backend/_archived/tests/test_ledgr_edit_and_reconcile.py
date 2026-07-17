"""Tests for new PUT (edit) endpoints and POST /api/ai/reconcile-statement.

Covers:
- PUT /api/suppliers/{id}  (update + 404)
- PUT /api/bills/{id}      (update + dashboard totals reflect + 404)
- PUT /api/sales/{id}      (update + 404)
- PUT /api/payments/{id}   (update + 404)
- POST /api/ai/reconcile-statement
    * missing key -> 401
    * bogus key   -> 400 with INVALID_ARGUMENT / API_KEY_INVALID (proves model resolves)
    * missing imageBase64 -> 422
"""
import pytest
import requests
from datetime import datetime, timezone


@pytest.fixture(scope="module")
def snapshot(api_client, base_url):
    """Snapshot & restore full DB around this module."""
    r = api_client.get(f"{base_url}/api/backup/export")
    assert r.status_code == 200
    snap = r.json()
    yield snap
    payload = {
        "mode": "replace",
        "suppliers": snap.get("suppliers", []),
        "bills": snap.get("bills", []),
        "sales": snap.get("sales", []),
        "payments": snap.get("payments", []),
        "inventoryChecks": snap.get("inventoryChecks", []),
        "settings": snap.get("settings") or {},
    }
    api_client.post(f"{base_url}/api/backup/import", json=payload)


def _no_underscore_id(doc):
    assert "_id" not in doc, f"_id leaked in response: {doc}"


# -------- PUT /api/suppliers/{id} --------
class TestPutSupplier:
    def test_update_supplier_fields(self, api_client, base_url, snapshot):
        r = api_client.post(f"{base_url}/api/suppliers",
                            json={"name": "TEST_EditSup", "phone": "111", "notes": "old"})
        sid = r.json()["id"]

        upd = api_client.put(f"{base_url}/api/suppliers/{sid}",
                             json={"name": "TEST_EditSup_v2", "phone": "222", "notes": "new"})
        assert upd.status_code == 200, upd.text
        body = upd.json()
        _no_underscore_id(body)
        assert body["id"] == sid
        assert body["name"] == "TEST_EditSup_v2"
        assert body["phone"] == "222"
        assert body["notes"] == "new"

        # GET verifies persistence (list -> find)
        got = api_client.get(f"{base_url}/api/suppliers/{sid}").json()
        assert got["name"] == "TEST_EditSup_v2"
        assert got["phone"] == "222"

        api_client.delete(f"{base_url}/api/suppliers/{sid}")

    def test_update_supplier_404(self, api_client, base_url, snapshot):
        r = api_client.put(f"{base_url}/api/suppliers/does-not-exist-xyz",
                           json={"name": "x", "phone": "", "notes": ""})
        assert r.status_code == 404


# -------- PUT /api/bills/{id} + dashboard reflect --------
class TestPutBill:
    def test_update_bill_and_dashboard_totals(self, api_client, base_url, snapshot):
        # create supplier
        sup = api_client.post(f"{base_url}/api/suppliers", json={"name": "TEST_BillEdit"}).json()
        sid = sup["id"]

        # Baseline dashboard
        base_dash = api_client.get(f"{base_url}/api/dashboard").json()
        base_purchases = base_dash["totalPurchases"]

        # Create bill $100
        rb = api_client.post(f"{base_url}/api/bills", json={
            "supplierId": sid, "date": "2026-01-10", "amount": 100,
            "currency": "USD", "paymentType": "credit",
            "invoiceNo": "INV-1", "notes": "n1",
        })
        assert rb.status_code == 200
        bill = rb.json()
        bid = bill["id"]

        after_create = api_client.get(f"{base_url}/api/dashboard").json()
        assert round(after_create["totalPurchases"] - base_purchases, 2) == 100.0

        # Update bill -> $250, cash, new invoice
        upd = api_client.put(f"{base_url}/api/bills/{bid}", json={
            "supplierId": sid, "date": "2026-01-12", "amount": 250,
            "currency": "USD", "paymentType": "cash",
            "invoiceNo": "INV-2", "notes": "n2", "photo": "",
        })
        assert upd.status_code == 200, upd.text
        body = upd.json()
        _no_underscore_id(body)
        assert body["id"] == bid
        assert body["amount"] == 250
        assert body["paymentType"] == "cash"
        assert body["invoiceNo"] == "INV-2"
        assert body["date"] == "2026-01-12"

        # Dashboard reflects update: baseline + 250, not + 100
        after_upd = api_client.get(f"{base_url}/api/dashboard").json()
        assert round(after_upd["totalPurchases"] - base_purchases, 2) == 250.0

        # Supplier balance reflects (cash bill still contributes to billsTotal)
        sup_detail = api_client.get(f"{base_url}/api/suppliers/{sid}").json()
        assert sup_detail["billsTotal"] == 250.0

        # cleanup
        api_client.delete(f"{base_url}/api/bills/{bid}")
        api_client.delete(f"{base_url}/api/suppliers/{sid}")

    def test_update_bill_404(self, api_client, base_url, snapshot):
        r = api_client.put(f"{base_url}/api/bills/nope-xyz", json={
            "supplierId": "x", "date": "2026-01-01", "amount": 1, "currency": "USD",
        })
        assert r.status_code == 404


# -------- PUT /api/sales/{id} --------
class TestPutSale:
    def test_update_sale(self, api_client, base_url, snapshot):
        rs = api_client.post(f"{base_url}/api/sales",
                             json={"date": "2026-01-05", "amount": 50, "currency": "USD"})
        sid = rs.json()["id"]

        upd = api_client.put(f"{base_url}/api/sales/{sid}", json={
            "date": "2026-01-06", "amount": 75, "currency": "USD", "notes": "edited",
        })
        assert upd.status_code == 200, upd.text
        body = upd.json()
        _no_underscore_id(body)
        assert body["amount"] == 75
        assert body["date"] == "2026-01-06"
        assert body["notes"] == "edited"

        api_client.delete(f"{base_url}/api/sales/{sid}")

    def test_update_sale_404(self, api_client, base_url, snapshot):
        r = api_client.put(f"{base_url}/api/sales/none-xyz", json={
            "date": "2026-01-01", "amount": 1, "currency": "USD",
        })
        assert r.status_code == 404


# -------- PUT /api/payments/{id} --------
class TestPutPayment:
    def test_update_payment(self, api_client, base_url, snapshot):
        sup = api_client.post(f"{base_url}/api/suppliers", json={"name": "TEST_PayEdit"}).json()
        sid = sup["id"]

        rp = api_client.post(f"{base_url}/api/payments", json={
            "date": "2026-01-05", "amount": 30, "currency": "USD",
            "type": "supplier_payment", "supplierId": sid, "method": "cash",
        })
        pid = rp.json()["id"]

        upd = api_client.put(f"{base_url}/api/payments/{pid}", json={
            "date": "2026-01-07", "amount": 45, "currency": "USD",
            "type": "drawing", "supplierId": "", "partnerName": "Alice",
            "method": "bank", "reference": "REF-9", "notes": "updated",
        })
        assert upd.status_code == 200, upd.text
        body = upd.json()
        _no_underscore_id(body)
        assert body["amount"] == 45
        assert body["type"] == "drawing"
        assert body["partnerName"] == "Alice"
        assert body["method"] == "bank"
        assert body["reference"] == "REF-9"
        assert body["date"] == "2026-01-07"

        api_client.delete(f"{base_url}/api/payments/{pid}")
        api_client.delete(f"{base_url}/api/suppliers/{sid}")

    def test_update_payment_404(self, api_client, base_url, snapshot):
        r = api_client.put(f"{base_url}/api/payments/none-xyz", json={
            "date": "2026-01-01", "amount": 1, "currency": "USD",
            "type": "supplier_payment",
        })
        assert r.status_code == 404


# -------- POST /api/ai/reconcile-statement --------
# 1x1 transparent PNG
TINY_PNG_B64 = (
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
)


class TestReconcileStatement:
    def _clear_settings_key(self, api_client, base_url):
        api_client.put(f"{base_url}/api/settings", json={"googleApiKey": "", "fcRate": 1.0})

    def test_missing_key_returns_401(self, api_client, base_url, snapshot):
        self._clear_settings_key(api_client, base_url)
        r = requests.post(
            f"{base_url}/api/ai/reconcile-statement",
            json={"imageBase64": TINY_PNG_B64, "mimeType": "image/png"},
            headers={"Content-Type": "application/json"},
        )
        assert r.status_code == 401, r.text
        assert "Missing Google Gemini API key" in r.json().get("detail", "")

    def test_bogus_key_reaches_google(self, api_client, base_url, snapshot):
        """Bogus key => request reaches Google, model resolves (proves gemini-3.5-flash is valid),
        Google rejects the key with API_KEY_INVALID / INVALID_ARGUMENT => backend wraps as 400."""
        r = requests.post(
            f"{base_url}/api/ai/reconcile-statement",
            json={"imageBase64": TINY_PNG_B64, "mimeType": "image/png"},
            headers={"Content-Type": "application/json", "x-gemini-api-key": "test_key_xxx"},
        )
        assert r.status_code == 400, r.text
        detail = r.json().get("detail", "")
        # Must NOT be a model-not-found error
        assert "NOT_FOUND" not in detail, f"Model resolution failed: {detail}"
        assert "no longer available" not in detail, f"Model deprecated again: {detail}"
        # Must be an auth-shape error
        assert ("INVALID_ARGUMENT" in detail) or ("API_KEY_INVALID" in detail) or ("API key not valid" in detail), \
            f"Unexpected error shape: {detail}"

    def test_missing_imagebase64_returns_422(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/ai/reconcile-statement",
            json={"mimeType": "image/png"},
            headers={"x-gemini-api-key": "test_key_xxx"},
        )
        assert r.status_code == 422, r.text

    def test_schema_accepts_supplier_id(self, api_client, base_url, snapshot):
        """Schema should accept optional supplierId. Bogus key path still returns 400 (auth)."""
        r = requests.post(
            f"{base_url}/api/ai/reconcile-statement",
            json={"imageBase64": TINY_PNG_B64, "mimeType": "image/png", "supplierId": "some-id"},
            headers={"Content-Type": "application/json", "x-gemini-api-key": "test_key_xxx"},
        )
        # schema-valid => not 422; auth fails at Google => 400
        assert r.status_code == 400, r.text
