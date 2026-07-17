"""Ledgr new feature tests:
- GET /api/reports/daily-summary
- GET /api/backup/export
- POST /api/backup/import  (replace + merge + invalid)

Strategy for safe isolation:
- Take a FULL backup of the current DB state via /api/backup/export at session start.
- Run all tests.
- Restore full DB state via /api/backup/import (mode=replace) at session teardown,
  so we never destroy any pre-existing data even though `replace` wipes collections.
"""
import pytest
import requests
from datetime import datetime, timezone


# ---------------- fixtures ----------------
@pytest.fixture(scope="module")
def today_str():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


@pytest.fixture(scope="module")
def full_snapshot(api_client, base_url):
    """Snapshot the DB before tests, restore after."""
    r = api_client.get(f"{base_url}/api/backup/export")
    assert r.status_code == 200, f"snapshot failed: {r.text}"
    snap = r.json()
    yield snap
    # teardown: restore original state via replace
    payload = {
        "mode": "replace",
        "suppliers": snap.get("suppliers", []),
        "bills": snap.get("bills", []),
        "sales": snap.get("sales", []),
        "payments": snap.get("payments", []),
        "inventoryChecks": snap.get("inventoryChecks", []),
        "settings": snap.get("settings") or {},
    }
    r2 = api_client.post(f"{base_url}/api/backup/import", json=payload)
    assert r2.status_code == 200, f"restore failed: {r2.text}"


# ---------------- daily summary ----------------
class TestDailySummary:
    def test_daily_summary_with_seeded_data(self, api_client, base_url, today_str, full_snapshot):
        # Create supplier
        rs = api_client.post(f"{base_url}/api/suppliers", json={"name": "TEST_DailySup"})
        assert rs.status_code == 200
        sup_id = rs.json()["id"]

        # Sale $100
        r_sale = api_client.post(
            f"{base_url}/api/sales",
            json={"date": today_str, "amount": 100, "currency": "USD"},
        )
        assert r_sale.status_code == 200
        sale_id = r_sale.json()["id"]

        # Bill $40
        r_bill = api_client.post(
            f"{base_url}/api/bills",
            json={
                "supplierId": sup_id,
                "date": today_str,
                "amount": 40,
                "currency": "USD",
                "paymentType": "credit",
            },
        )
        assert r_bill.status_code == 200
        bill_id = r_bill.json()["id"]

        # supplier_payment $20
        r_pay = api_client.post(
            f"{base_url}/api/payments",
            json={
                "date": today_str,
                "amount": 20,
                "currency": "USD",
                "type": "supplier_payment",
                "supplierId": sup_id,
            },
        )
        assert r_pay.status_code == 200
        pay_id = r_pay.json()["id"]

        # Query daily summary
        r = api_client.get(f"{base_url}/api/reports/daily-summary", params={"date": today_str})
        assert r.status_code == 200
        d = r.json()

        # shape
        for k in [
            "date", "revenue", "purchases", "grossProfit", "supplierPayments",
            "drawings", "netCash", "billsCount", "salesCount", "paymentsCount", "suppliers",
        ]:
            assert k in d, f"missing key {k}"

        # numbers (>= since other same-day data might exist from prior tests theoretically,
        # but the snapshot fixture guarantees clean state at start of module)
        assert d["date"] == today_str
        assert d["revenue"] >= 100.0
        assert d["purchases"] >= 40.0
        assert round(d["grossProfit"], 2) == round(d["revenue"] - d["purchases"], 2)
        assert d["supplierPayments"] >= 20.0
        assert round(d["netCash"], 2) == round(d["revenue"] - d["supplierPayments"] - d["drawings"], 2)
        assert d["billsCount"] >= 1
        assert d["salesCount"] >= 1
        assert d["paymentsCount"] >= 1
        assert isinstance(d["suppliers"], list)
        # Our supplier should appear
        assert any(s.get("name") == "TEST_DailySup" for s in d["suppliers"])

        # cleanup created resources (safety - restore fixture will also clean)
        api_client.delete(f"{base_url}/api/payments/{pay_id}")
        api_client.delete(f"{base_url}/api/bills/{bill_id}")
        api_client.delete(f"{base_url}/api/sales/{sale_id}")
        api_client.delete(f"{base_url}/api/suppliers/{sup_id}")

    def test_daily_summary_empty_day(self, api_client, base_url):
        # Old date - should return zeros
        r = api_client.get(f"{base_url}/api/reports/daily-summary", params={"date": "1999-01-01"})
        assert r.status_code == 200
        d = r.json()
        assert d["revenue"] == 0
        assert d["purchases"] == 0
        assert d["grossProfit"] == 0
        assert d["billsCount"] == 0
        assert d["salesCount"] == 0
        assert d["paymentsCount"] == 0


# ---------------- backup export ----------------
class TestBackupExport:
    def test_export_shape_and_no_id(self, api_client, base_url, full_snapshot):
        r = api_client.get(f"{base_url}/api/backup/export")
        assert r.status_code == 200
        d = r.json()
        for k in ["suppliers", "bills", "sales", "payments", "inventoryChecks", "settings", "_meta"]:
            assert k in d, f"missing key {k}"
        assert d["_meta"]["app"] == "ledgr"
        assert d["_meta"]["version"] == 1
        assert "exportedAt" in d["_meta"]
        # ISO check
        datetime.fromisoformat(d["_meta"]["exportedAt"].replace("Z", "+00:00"))

        # no _id anywhere
        for coll_name in ["suppliers", "bills", "sales", "payments", "inventoryChecks"]:
            assert isinstance(d[coll_name], list)
            for item in d[coll_name]:
                assert "_id" not in item, f"_id leaked in {coll_name}"
        assert "_id" not in (d["settings"] or {})


# ---------------- backup import ----------------
class TestBackupImportReplace:
    def test_replace_wipes_and_restores(self, api_client, base_url, full_snapshot):
        # 1) Seed some fresh data
        rs = api_client.post(f"{base_url}/api/suppliers", json={"name": "TEST_ReplaceSup"})
        sup_id = rs.json()["id"]
        rb = api_client.post(f"{base_url}/api/bills", json={
            "supplierId": sup_id, "date": "2026-01-15", "amount": 77, "currency": "USD",
        })
        bill_id = rb.json()["id"]

        # 2) Export backup
        exp = api_client.get(f"{base_url}/api/backup/export").json()
        assert any(s["id"] == sup_id for s in exp["suppliers"])
        assert any(b["id"] == bill_id for b in exp["bills"])

        # 3) Wipe suppliers+bills by importing empty lists in replace mode
        wipe = api_client.post(f"{base_url}/api/backup/import", json={
            "mode": "replace", "suppliers": [], "bills": [],
        })
        assert wipe.status_code == 200
        assert wipe.json()["mode"] == "replace"
        # verify wiped
        assert api_client.get(f"{base_url}/api/suppliers").json() == []
        assert api_client.get(f"{base_url}/api/bills").json() == []

        # 4) Restore just suppliers+bills from earlier export
        restore = api_client.post(f"{base_url}/api/backup/import", json={
            "mode": "replace",
            "suppliers": exp["suppliers"],
            "bills": exp["bills"],
        })
        assert restore.status_code == 200
        got_sup = api_client.get(f"{base_url}/api/suppliers").json()
        assert any(s["id"] == sup_id for s in got_sup)
        got_bills = api_client.get(f"{base_url}/api/bills").json()
        assert any(b["id"] == bill_id for b in got_bills)

    def test_replace_omitted_collections_are_untouched(self, api_client, base_url, full_snapshot):
        # Ensure at least one sale exists
        rs = api_client.post(f"{base_url}/api/sales", json={
            "date": "2026-01-20", "amount": 55, "currency": "USD",
        })
        sale_id = rs.json()["id"]

        before_sales = api_client.get(f"{base_url}/api/sales").json()
        assert any(s["id"] == sale_id for s in before_sales)

        # Import ONLY suppliers - sales should remain untouched
        r = api_client.post(f"{base_url}/api/backup/import", json={
            "mode": "replace",
            "suppliers": [{"id": "test-only-sup", "name": "TEST_OnlySup", "phone": "",
                           "notes": "", "created_at": "2026-01-01T00:00:00+00:00"}],
        })
        assert r.status_code == 200
        after_sales = api_client.get(f"{base_url}/api/sales").json()
        assert any(s["id"] == sale_id for s in after_sales), "Sales were wiped when only suppliers were sent!"


class TestBackupImportMerge:
    def test_merge_upserts_by_id(self, api_client, base_url, full_snapshot):
        # existing supplier
        rs = api_client.post(f"{base_url}/api/suppliers", json={"name": "TEST_MergeSup"})
        sup = rs.json()
        sup_id = sup["id"]

        # snapshot suppliers before
        before = api_client.get(f"{base_url}/api/suppliers").json()
        before_ids = {s["id"] for s in before}

        # Merge: update existing + insert new one
        updated = dict(sup)
        updated["name"] = "TEST_MergeSup_UPDATED"
        new_sup = {
            "id": "test-merge-new-1",
            "name": "TEST_MergeSup_NEW",
            "phone": "",
            "notes": "",
            "created_at": "2026-01-01T00:00:00+00:00",
        }
        r = api_client.post(f"{base_url}/api/backup/import", json={
            "mode": "merge",
            "suppliers": [updated, new_sup],
        })
        assert r.status_code == 200
        assert r.json()["mode"] == "merge"

        # verify
        after = api_client.get(f"{base_url}/api/suppliers").json()
        after_map = {s["id"]: s for s in after}
        # original set still there (nothing wiped)
        for oid in before_ids:
            assert oid in after_map, f"merge wiped {oid}"
        # updated in place
        assert after_map[sup_id]["name"] == "TEST_MergeSup_UPDATED"
        # new appended
        assert "test-merge-new-1" in after_map
        assert after_map["test-merge-new-1"]["name"] == "TEST_MergeSup_NEW"


class TestBackupImportErrors:
    def test_malformed_body_returns_4xx(self, api_client, base_url):
        # suppliers must be list, sending int should trigger 422
        r = api_client.post(f"{base_url}/api/backup/import", json={
            "mode": "replace", "suppliers": 123,
        })
        assert 400 <= r.status_code < 500, f"expected 4xx, got {r.status_code}"

    def test_invalid_mode_returns_4xx(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/backup/import", json={
            "mode": "wipe_the_universe",
        })
        assert 400 <= r.status_code < 500

    def test_non_json_body_returns_4xx(self, api_client, base_url):
        r = requests.post(
            f"{base_url}/api/backup/import",
            data="this is not json",
            headers={"Content-Type": "application/json"},
        )
        assert 400 <= r.status_code < 500
