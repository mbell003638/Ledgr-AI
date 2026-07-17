from fastapi import FastAPI, APIRouter, HTTPException, Header
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import base64
import json
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Literal
import uuid
from datetime import datetime, timezone

from google import genai
from google.genai import types as gtypes


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

app = FastAPI()
api_router = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

GEMINI_MODEL = "gemini-3.5-flash"


# ---------- Models ----------
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Supplier(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    phone: Optional[str] = ""
    notes: Optional[str] = ""
    created_at: str = Field(default_factory=now_iso)


class SupplierCreate(BaseModel):
    name: str
    phone: Optional[str] = ""
    notes: Optional[str] = ""


class Bill(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    supplierId: str
    date: str
    amount: float
    currency: Literal["USD", "CDF"] = "USD"
    rate: float = 1.0  # FC rate at time of entry
    paymentType: Literal["credit", "cash"] = "credit"
    invoiceNo: Optional[str] = ""
    notes: Optional[str] = ""
    photo: Optional[str] = ""  # base64
    ocrText: Optional[str] = ""
    created_at: str = Field(default_factory=now_iso)


class BillCreate(BaseModel):
    supplierId: str
    date: str
    amount: float
    currency: Literal["USD", "CDF"] = "USD"
    rate: float = 1.0
    paymentType: Literal["credit", "cash"] = "credit"
    invoiceNo: Optional[str] = ""
    notes: Optional[str] = ""
    photo: Optional[str] = ""
    ocrText: Optional[str] = ""


class Sale(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    date: str
    amount: float
    currency: Literal["USD", "CDF"] = "USD"
    rate: float = 1.0
    notes: Optional[str] = ""
    created_at: str = Field(default_factory=now_iso)


class SaleCreate(BaseModel):
    date: str
    amount: float
    currency: Literal["USD", "CDF"] = "USD"
    rate: float = 1.0
    notes: Optional[str] = ""


class Payment(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    date: str
    amount: float
    currency: Literal["USD", "CDF"] = "USD"
    rate: float = 1.0
    type: Literal["supplier_payment", "drawing"] = "supplier_payment"
    supplierId: Optional[str] = ""
    partnerName: Optional[str] = ""
    method: Optional[str] = "cash"
    reference: Optional[str] = ""
    notes: Optional[str] = ""
    created_at: str = Field(default_factory=now_iso)


class PaymentCreate(BaseModel):
    date: str
    amount: float
    currency: Literal["USD", "CDF"] = "USD"
    rate: float = 1.0
    type: Literal["supplier_payment", "drawing"] = "supplier_payment"
    supplierId: Optional[str] = ""
    partnerName: Optional[str] = ""
    method: Optional[str] = "cash"
    reference: Optional[str] = ""
    notes: Optional[str] = ""


class InventoryCheck(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    date: str
    expectedStock: float
    actualStock: float
    variance: float
    notes: Optional[str] = ""
    created_at: str = Field(default_factory=now_iso)


class InventoryCheckCreate(BaseModel):
    date: str
    expectedStock: float
    actualStock: float
    notes: Optional[str] = ""


class SettingsModel(BaseModel):
    googleApiKey: Optional[str] = ""
    fcRate: float = 1.0  # 1 USD = fcRate CDF
    managerCommissionPct: Optional[float] = 0.0
    currentPeriodStart: Optional[str] = "1970-01-01"
    openingInventory: Optional[float] = 0.0
    openingCash: Optional[float] = 0.0


class ClosedPeriod(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    startDate: str
    endDate: str
    openingInventory: float
    openingCash: float
    totalSales: float
    totalPurchases: float
    grossProfit: float
    managerCommissionPct: float
    commission: float
    drawings: float
    supplierPayments: float
    netProfit: float
    closingInventory: float
    closingCash: float
    notes: Optional[str] = ""
    closed_at: str = Field(default_factory=now_iso)


class ClosePeriodIn(BaseModel):
    actualStock: float
    notes: Optional[str] = ""


class GeminiTextIn(BaseModel):
    text: str


class GeminiImageIn(BaseModel):
    imageBase64: str
    mimeType: str = "image/jpeg"


class GeminiAudioIn(BaseModel):
    audioBase64: str
    mimeType: str = "audio/m4a"


# ---------- helpers ----------
def scrub(doc: dict) -> dict:
    if not doc:
        return doc
    doc.pop("_id", None)
    return doc


async def get_api_key(header_key: str) -> str:
    if header_key:
        return header_key.strip()
    s = await db.settings.find_one({"_id": "app"})
    if s and s.get("googleApiKey"):
        return s["googleApiKey"]
    raise HTTPException(status_code=401, detail="Missing Google Gemini API key. Set it in Settings.")


def gemini_client(api_key: str) -> genai.Client:
    return genai.Client(api_key=api_key)


# ---------- root ----------
@api_router.get("/")
async def root():
    return {"status": "ok", "app": "vocash-accounting"}


# ---------- Settings ----------
@api_router.get("/settings")
async def get_settings():
    s = await db.settings.find_one({"_id": "app"})
    if not s:
        return {"googleApiKey": "", "fcRate": 1.0, "managerCommissionPct": 0.0,
                "currentPeriodStart": "1970-01-01", "openingInventory": 0.0, "openingCash": 0.0}
    s.pop("_id", None)
    return {
        "googleApiKey": s.get("googleApiKey", ""),
        "fcRate": s.get("fcRate", 1.0),
        "managerCommissionPct": s.get("managerCommissionPct", 0.0),
        "currentPeriodStart": s.get("currentPeriodStart", "1970-01-01"),
        "openingInventory": s.get("openingInventory", 0.0),
        "openingCash": s.get("openingCash", 0.0),
    }


@api_router.put("/settings")
async def update_settings(body: SettingsModel):
    # Only update explicitly provided fields so partial updates don't wipe others
    doc = body.model_dump(exclude_unset=True)
    if doc:
        await db.settings.update_one({"_id": "app"}, {"$set": doc}, upsert=True)
    s = await db.settings.find_one({"_id": "app"}, {"_id": 0}) or {}
    return s


@api_router.post("/settings/test-key")
async def test_key(x_gemini_api_key: str = Header(default="")):
    key = await get_api_key(x_gemini_api_key)
    try:
        c = gemini_client(key)
        resp = c.models.generate_content(
            model=GEMINI_MODEL,
            contents="Reply with the single word: OK",
        )
        text = (resp.text or "").strip()
        return {"ok": True, "reply": text}
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Gemini test failed: {e}")


# ---------- Suppliers ----------
@api_router.get("/suppliers")
async def list_suppliers():
    items = await db.suppliers.find({}, {"_id": 0}).to_list(1000)
    # attach balance
    bills = await db.bills.find({}, {"_id": 0}).to_list(5000)
    payments = await db.payments.find({"type": "supplier_payment"}, {"_id": 0}).to_list(5000)
    settings = await db.settings.find_one({"_id": "app"}) or {}
    fc_rate = settings.get("fcRate", 1.0) or 1.0

    def to_usd(amount, currency, rate):
        if currency == "USD":
            return float(amount)
        r = rate or fc_rate or 1.0
        return float(amount) / r if r else 0.0

    for s in items:
        bill_total = sum(to_usd(b["amount"], b.get("currency", "USD"), b.get("rate", fc_rate))
                         for b in bills if b.get("supplierId") == s["id"])
        pay_total = sum(to_usd(p["amount"], p.get("currency", "USD"), p.get("rate", fc_rate))
                        for p in payments if p.get("supplierId") == s["id"])
        s["balance"] = round(bill_total - pay_total, 2)
        s["billsTotal"] = round(bill_total, 2)
        s["paymentsTotal"] = round(pay_total, 2)
    return items


@api_router.post("/suppliers", response_model=Supplier)
async def create_supplier(body: SupplierCreate):
    s = Supplier(**body.model_dump())
    await db.suppliers.insert_one(s.model_dump())
    return s


@api_router.get("/suppliers/{sid}")
async def get_supplier(sid: str):
    s = await db.suppliers.find_one({"id": sid}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Supplier not found")
    bills = await db.bills.find({"supplierId": sid}, {"_id": 0}).sort("date", -1).to_list(1000)
    payments = await db.payments.find({"supplierId": sid, "type": "supplier_payment"}, {"_id": 0}).sort("date", -1).to_list(1000)
    settings = await db.settings.find_one({"_id": "app"}) or {}
    fc_rate = settings.get("fcRate", 1.0) or 1.0

    def to_usd(amount, currency, rate):
        if currency == "USD":
            return float(amount)
        r = rate or fc_rate or 1.0
        return float(amount) / r if r else 0.0

    bill_total = sum(to_usd(b["amount"], b.get("currency", "USD"), b.get("rate", fc_rate)) for b in bills)
    pay_total = sum(to_usd(p["amount"], p.get("currency", "USD"), p.get("rate", fc_rate)) for p in payments)
    s["balance"] = round(bill_total - pay_total, 2)
    s["billsTotal"] = round(bill_total, 2)
    s["paymentsTotal"] = round(pay_total, 2)
    s["bills"] = bills
    s["payments"] = payments
    return s


@api_router.delete("/suppliers/{sid}")
async def delete_supplier(sid: str):
    await db.suppliers.delete_one({"id": sid})
    return {"ok": True}


@api_router.put("/suppliers/{sid}")
async def update_supplier(sid: str, body: SupplierCreate):
    doc = body.model_dump()
    await db.suppliers.update_one({"id": sid}, {"$set": doc})
    s = await db.suppliers.find_one({"id": sid}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Supplier not found")
    return s


# ---------- Bills ----------
@api_router.get("/bills")
async def list_bills():
    items = await db.bills.find({}, {"_id": 0}).sort("date", -1).to_list(2000)
    return items


@api_router.post("/bills", response_model=Bill)
async def create_bill(body: BillCreate):
    b = Bill(**body.model_dump())
    await db.bills.insert_one(b.model_dump())
    return b


@api_router.delete("/bills/{bid}")
async def delete_bill(bid: str):
    await db.bills.delete_one({"id": bid})
    return {"ok": True}


@api_router.put("/bills/{bid}")
async def update_bill(bid: str, body: BillCreate):
    doc = body.model_dump()
    await db.bills.update_one({"id": bid}, {"$set": doc})
    b = await db.bills.find_one({"id": bid}, {"_id": 0})
    if not b:
        raise HTTPException(404, "Bill not found")
    return b


# ---------- Sales ----------
@api_router.get("/sales")
async def list_sales():
    items = await db.sales.find({}, {"_id": 0}).sort("date", -1).to_list(2000)
    return items


@api_router.post("/sales", response_model=Sale)
async def create_sale(body: SaleCreate):
    s = Sale(**body.model_dump())
    await db.sales.insert_one(s.model_dump())
    return s


@api_router.delete("/sales/{sid}")
async def delete_sale(sid: str):
    await db.sales.delete_one({"id": sid})
    return {"ok": True}


@api_router.put("/sales/{sid}")
async def update_sale(sid: str, body: SaleCreate):
    doc = body.model_dump()
    await db.sales.update_one({"id": sid}, {"$set": doc})
    s = await db.sales.find_one({"id": sid}, {"_id": 0})
    if not s:
        raise HTTPException(404, "Sale not found")
    return s


# ---------- Payments ----------
@api_router.get("/payments")
async def list_payments():
    items = await db.payments.find({}, {"_id": 0}).sort("date", -1).to_list(2000)
    return items


@api_router.post("/payments", response_model=Payment)
async def create_payment(body: PaymentCreate):
    p = Payment(**body.model_dump())
    await db.payments.insert_one(p.model_dump())
    return p


@api_router.delete("/payments/{pid}")
async def delete_payment(pid: str):
    await db.payments.delete_one({"id": pid})
    return {"ok": True}


@api_router.put("/payments/{pid}")
async def update_payment(pid: str, body: PaymentCreate):
    doc = body.model_dump()
    await db.payments.update_one({"id": pid}, {"$set": doc})
    p = await db.payments.find_one({"id": pid}, {"_id": 0})
    if not p:
        raise HTTPException(404, "Payment not found")
    return p


# ---------- Inventory ----------
@api_router.get("/inventory")
async def list_inventory():
    items = await db.inventoryChecks.find({}, {"_id": 0}).sort("date", -1).to_list(1000)
    return items


@api_router.get("/inventory/expected")
async def compute_expected():
    """Expected stock (USD value) = last actualStock + purchases since - sales since."""
    last = await db.inventoryChecks.find_one({}, {"_id": 0}, sort=[("date", -1)])
    settings = await db.settings.find_one({"_id": "app"}) or {}
    fc_rate = settings.get("fcRate", 1.0) or 1.0

    def to_usd(amount, currency, rate):
        if currency == "USD":
            return float(amount)
        r = rate or fc_rate or 1.0
        return float(amount) / r if r else 0.0

    since = last["date"] if last else "0000-01-01"
    base = last["actualStock"] if last else 0.0
    bills = await db.bills.find({"date": {"$gt": since}}, {"_id": 0}).to_list(5000)
    sales = await db.sales.find({"date": {"$gt": since}}, {"_id": 0}).to_list(5000)
    p_total = sum(to_usd(b["amount"], b.get("currency", "USD"), b.get("rate", fc_rate)) for b in bills)
    s_total = sum(to_usd(s["amount"], s.get("currency", "USD"), s.get("rate", fc_rate)) for s in sales)
    expected = round(base + p_total - s_total, 2)
    return {"expected": expected, "lastAudit": last, "purchasesSince": round(p_total, 2), "salesSince": round(s_total, 2)}


@api_router.post("/inventory", response_model=InventoryCheck)
async def create_inventory(body: InventoryCheckCreate):
    variance = round(body.actualStock - body.expectedStock, 2)
    obj = InventoryCheck(
        date=body.date,
        expectedStock=body.expectedStock,
        actualStock=body.actualStock,
        variance=variance,
        notes=body.notes,
    )
    await db.inventoryChecks.insert_one(obj.model_dump())
    return obj


@api_router.delete("/inventory/{iid}")
async def delete_inventory(iid: str):
    await db.inventoryChecks.delete_one({"id": iid})
    return {"ok": True}


# ---------- Dashboard ----------
@api_router.get("/dashboard")
async def dashboard():
    settings = await db.settings.find_one({"_id": "app"}) or {}
    fc_rate = settings.get("fcRate", 1.0) or 1.0
    period_start = settings.get("currentPeriodStart", "1970-01-01") or "1970-01-01"
    opening_inv = float(settings.get("openingInventory", 0.0) or 0.0)
    opening_cash = float(settings.get("openingCash", 0.0) or 0.0)
    commission_pct = float(settings.get("managerCommissionPct", 0.0) or 0.0)

    def to_usd(amount, currency, rate):
        if currency == "USD":
            return float(amount)
        r = rate or fc_rate or 1.0
        return float(amount) / r if r else 0.0

    q = {"date": {"$gte": period_start}}
    bills = await db.bills.find(q, {"_id": 0}).to_list(5000)
    sales = await db.sales.find(q, {"_id": 0}).to_list(5000)
    payments = await db.payments.find(q, {"_id": 0}).to_list(5000)
    inv = await db.inventoryChecks.find_one(q, {"_id": 0}, sort=[("date", -1)])
    suppliers = await db.suppliers.count_documents({})

    total_purchases = sum(to_usd(b["amount"], b.get("currency", "USD"), b.get("rate", fc_rate)) for b in bills)
    total_sales = sum(to_usd(s["amount"], s.get("currency", "USD"), s.get("rate", fc_rate)) for s in sales)
    supplier_payments = sum(to_usd(p["amount"], p.get("currency", "USD"), p.get("rate", fc_rate))
                            for p in payments if p.get("type") == "supplier_payment")
    drawings = sum(to_usd(p["amount"], p.get("currency", "USD"), p.get("rate", fc_rate))
                   for p in payments if p.get("type") == "drawing")

    gross_profit = round(total_sales - total_purchases, 2)
    commission = round(gross_profit * commission_pct / 100.0, 2) if gross_profit > 0 else 0.0
    net_profit = round(gross_profit - commission - drawings, 2)

    liabilities = round(total_purchases - supplier_payments + commission, 2)
    inventory_value = float(inv["actualStock"]) if inv else opening_inv
    cash = round(opening_cash + total_sales - supplier_payments - drawings, 2)
    assets = round(cash + inventory_value, 2)
    opening_balance = round(opening_cash + opening_inv, 2)
    closing_balance = round(assets, 2)
    net_worth = round(assets - liabilities, 2)

    from collections import defaultdict
    trend = defaultdict(float)
    for s in sales:
        d = s.get("date", "")[:10]
        trend[d] += to_usd(s["amount"], s.get("currency", "USD"), s.get("rate", fc_rate))
    sorted_trend = sorted(trend.items())[-7:]

    return {
        "assets": assets,
        "liabilities": liabilities,
        "netWorth": net_worth,
        "cash": cash,
        "inventoryValue": inventory_value,
        "openingBalance": opening_balance,
        "openingInventory": opening_inv,
        "openingCash": opening_cash,
        "closingBalance": closing_balance,
        "totalPurchases": round(total_purchases, 2),
        "totalSales": round(total_sales, 2),
        "grossProfit": gross_profit,
        "managerCommissionPct": commission_pct,
        "commission": commission,
        "netProfit": net_profit,
        "drawings": round(drawings, 2),
        "supplierPayments": round(supplier_payments, 2),
        "suppliers": suppliers,
        "periodStart": period_start,
        "salesTrend": [{"date": d, "value": round(v, 2)} for d, v in sorted_trend],
    }


# ---------- Reports ----------
@api_router.get("/reports/pnl")
async def report_pnl():
    d = await dashboard()
    return {
        "revenue": d["totalSales"],
        "cogs": d["totalPurchases"],
        "grossProfit": d["grossProfit"],
        "managerCommissionPct": d["managerCommissionPct"],
        "commission": d["commission"],
        "drawings": d["drawings"],
        "netProfit": d["netProfit"],
    }


@api_router.get("/reports/balance-sheet")
async def report_bs():
    d = await dashboard()
    return {
        "assets": {
            "cash": d["cash"],
            "inventory": d["inventoryValue"],
            "total": d["assets"],
        },
        "liabilities": {
            "suppliersPayable": d["liabilities"],
            "total": d["liabilities"],
        },
        "equity": d["netWorth"],
    }


@api_router.get("/reports/trial-balance")
async def report_tb():
    d = await dashboard()
    return {
        "debits": [
            {"account": "Cash", "amount": d["cash"]},
            {"account": "Inventory", "amount": d["inventoryValue"]},
            {"account": "Purchases", "amount": d["totalPurchases"]},
            {"account": "Drawings", "amount": d["drawings"]},
        ],
        "credits": [
            {"account": "Sales Revenue", "amount": d["totalSales"]},
            {"account": "Suppliers Payable", "amount": d["liabilities"]},
        ],
    }


# ---------- Gemini AI endpoints ----------
PARSE_SCHEMA = {
    "type": "object",
    "properties": {
        "intent": {"type": "string", "enum": ["bill", "sale", "supplier_payment", "drawing", "inventory", "unknown"]},
        "date": {"type": "string"},
        "amount": {"type": "number"},
        "currency": {"type": "string", "enum": ["USD", "CDF"]},
        "supplierName": {"type": "string"},
        "partnerName": {"type": "string"},
        "paymentType": {"type": "string", "enum": ["cash", "credit"]},
        "notes": {"type": "string"},
        "summary": {"type": "string"},
    },
    "required": ["intent", "summary"],
}

OCR_SCHEMA = {
    "type": "object",
    "properties": {
        "supplierName": {"type": "string"},
        "date": {"type": "string"},
        "amount": {"type": "number"},
        "currency": {"type": "string"},
        "invoiceNo": {"type": "string"},
        "rawText": {"type": "string"},
    },
}

TRANSCRIBE_SCHEMA = {
    "type": "object",
    "properties": {"transcript": {"type": "string"}},
    "required": ["transcript"],
}


@api_router.post("/ai/parse-command")
async def parse_command(body: GeminiTextIn, x_gemini_api_key: str = Header(default="")):
    key = await get_api_key(x_gemini_api_key)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    prompt = (
        f"Today is {today}. Parse this shop accounting voice command into JSON. "
        "Intents: 'bill' (vendor purchase), 'sale' (customer revenue), "
        "'supplier_payment' (paying a supplier), 'drawing' (partner withdrawal), "
        "'inventory' (stock count). "
        "Use ISO date YYYY-MM-DD. Default currency USD unless CDF/FC/Franc is mentioned. "
        "Provide a short human summary. "
        "Command: " + body.text
    )
    try:
        c = gemini_client(key)
        resp = c.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=gtypes.GenerateContentConfig(
                temperature=0,
                response_mime_type="application/json",
                response_schema=PARSE_SCHEMA,
            ),
        )
        data = json.loads(resp.text)
        return data
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Parse failed: {e}")


@api_router.post("/ai/ocr-receipt")
async def ocr_receipt(body: GeminiImageIn, x_gemini_api_key: str = Header(default="")):
    key = await get_api_key(x_gemini_api_key)
    try:
        img = base64.b64decode(body.imageBase64)
        part = gtypes.Part.from_bytes(data=img, mime_type=body.mimeType)
        prompt = ("Extract from this receipt/invoice: supplierName (business name), "
                  "date (YYYY-MM-DD), amount (total), currency (USD or CDF), "
                  "invoiceNo, rawText (full text). Return JSON.")
        c = gemini_client(key)
        resp = c.models.generate_content(
            model=GEMINI_MODEL,
            contents=[prompt, part],
            config=gtypes.GenerateContentConfig(
                temperature=0,
                response_mime_type="application/json",
                response_schema=OCR_SCHEMA,
            ),
        )
        return json.loads(resp.text)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"OCR failed: {e}")


@api_router.post("/ai/transcribe")
async def transcribe(body: GeminiAudioIn, x_gemini_api_key: str = Header(default="")):
    key = await get_api_key(x_gemini_api_key)
    try:
        audio = base64.b64decode(body.audioBase64)
        part = gtypes.Part.from_bytes(data=audio, mime_type=body.mimeType)
        prompt = "Transcribe this audio verbatim. Return JSON with a 'transcript' field."
        c = gemini_client(key)
        resp = c.models.generate_content(
            model=GEMINI_MODEL,
            contents=[prompt, part],
            config=gtypes.GenerateContentConfig(
                temperature=0,
                response_mime_type="application/json",
                response_schema=TRANSCRIBE_SCHEMA,
            ),
        )
        return json.loads(resp.text)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Transcription failed: {e}")


STATEMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "supplierName": {"type": "string"},
        "entries": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "date": {"type": "string"},
                    "amount": {"type": "number"},
                    "type": {"type": "string", "enum": ["bill", "payment", "unknown"]},
                    "description": {"type": "string"},
                    "reference": {"type": "string"},
                },
            },
        },
        "totalOnStatement": {"type": "number"},
    },
    "required": ["entries"],
}


class ReconcileIn(BaseModel):
    imageBase64: str
    mimeType: str = "image/jpeg"
    supplierId: Optional[str] = ""


@api_router.post("/ai/reconcile-statement")
async def reconcile_statement(body: ReconcileIn, x_gemini_api_key: str = Header(default="")):
    """Photograph a supplier statement; Gemini extracts line items, we compare with our records."""
    key = await get_api_key(x_gemini_api_key)
    try:
        img = base64.b64decode(body.imageBase64)
        part = gtypes.Part.from_bytes(data=img, mime_type=body.mimeType)
        prompt = (
            "Extract every line item from this supplier statement / ledger photo. "
            "For each line, return: date (YYYY-MM-DD), amount (positive number), "
            "type ('bill' for purchase/invoice/debit or 'payment' for credit/payment received), "
            "description, reference/invoice number. Also return the statement's total if visible. "
            "Return JSON matching the schema."
        )
        c = gemini_client(key)
        resp = c.models.generate_content(
            model=GEMINI_MODEL,
            contents=[prompt, part],
            config=gtypes.GenerateContentConfig(
                temperature=0,
                response_mime_type="application/json",
                response_schema=STATEMENT_SCHEMA,
            ),
        )
        extracted = json.loads(resp.text)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Reconciliation OCR failed: {e}")

    our_bills = []
    our_payments = []
    if body.supplierId:
        our_bills = await db.bills.find({"supplierId": body.supplierId}, {"_id": 0}).to_list(2000)
        our_payments = await db.payments.find(
            {"supplierId": body.supplierId, "type": "supplier_payment"}, {"_id": 0}).to_list(2000)

    def _match(entry, pool):
        from datetime import datetime as dt
        try:
            e_date = dt.fromisoformat(entry.get("date", ""))
        except Exception:
            e_date = None
        e_amt = float(entry.get("amount", 0) or 0)
        for o in pool:
            try:
                o_date = dt.fromisoformat(o.get("date", ""))
            except Exception:
                o_date = None
            if e_date and o_date and abs((e_date - o_date).days) > 3:
                continue
            o_amt = float(o.get("amount", 0) or 0)
            if e_amt and o_amt and abs(o_amt - e_amt) / max(e_amt, 1) <= 0.01:
                return o
        return None

    matched, missing = [], []
    for e in extracted.get("entries", []):
        if e.get("type") == "bill":
            pool = our_bills
        elif e.get("type") == "payment":
            pool = our_payments
        else:
            pool = our_bills + our_payments
        m = _match(e, pool)
        if m:
            matched.append({"statement": e, "ledgr": m})
        else:
            missing.append(e)

    stmt_refs = [(e.get("date"), float(e.get("amount", 0) or 0)) for e in extracted.get("entries", [])]
    extra = []
    for o in (our_bills + our_payments):
        o_amt = float(o.get("amount", 0) or 0)
        found = False
        for d, a in stmt_refs:
            if d and o.get("date") == d and a and abs(a - o_amt) / max(a, 1) <= 0.01:
                found = True
                break
        if not found:
            extra.append(o)

    return {
        "extracted": extracted,
        "matched": matched,
        "missingInLedgr": missing,
        "notOnStatement": extra,
        "supplierId": body.supplierId,
    }




@api_router.get("/reports/monthly-summary")
async def monthly_summary(month: str):
    """month format: YYYY-MM. Returns full monthly P&L + top suppliers + cash flow."""
    settings = await db.settings.find_one({"_id": "app"}) or {}
    fc_rate = settings.get("fcRate", 1.0) or 1.0

    def to_usd(amount, currency, rate):
        if currency == "USD":
            return float(amount)
        r = rate or fc_rate or 1.0
        return float(amount) / r if r else 0.0

    start = f"{month}-01"
    # naive end of month
    y, m = month.split("-")
    ny, nm = (int(y) + 1, 1) if int(m) == 12 else (int(y), int(m) + 1)
    end = f"{ny:04d}-{nm:02d}-01"

    q = {"date": {"$gte": start, "$lt": end}}
    bills = await db.bills.find(q, {"_id": 0}).to_list(5000)
    sales = await db.sales.find(q, {"_id": 0}).to_list(5000)
    payments = await db.payments.find(q, {"_id": 0}).to_list(5000)

    suppliers_all = await db.suppliers.find({}, {"_id": 0}).to_list(1000)
    sup_map = {s["id"]: s["name"] for s in suppliers_all}

    revenue = sum(to_usd(s["amount"], s.get("currency", "USD"), s.get("rate", fc_rate)) for s in sales)
    purchases = sum(to_usd(b["amount"], b.get("currency", "USD"), b.get("rate", fc_rate)) for b in bills)
    supplier_pay = sum(to_usd(p["amount"], p.get("currency", "USD"), p.get("rate", fc_rate))
                       for p in payments if p.get("type") == "supplier_payment")
    drawings = sum(to_usd(p["amount"], p.get("currency", "USD"), p.get("rate", fc_rate))
                   for p in payments if p.get("type") == "drawing")

    gross_profit = round(revenue - purchases, 2)
    net_profit = round(gross_profit - drawings, 2)
    cash_flow = round(revenue - supplier_pay - drawings, 2)

    # Top suppliers by purchase volume
    from collections import defaultdict
    sup_totals = defaultdict(float)
    for b in bills:
        sid = b.get("supplierId", "")
        sup_totals[sid] += to_usd(b["amount"], b.get("currency", "USD"), b.get("rate", fc_rate))
    top = sorted(
        [{"supplierId": k, "name": sup_map.get(k, "Unknown"), "amount": round(v, 2)}
         for k, v in sup_totals.items() if v > 0],
        key=lambda x: x["amount"], reverse=True,
    )[:5]

    # Daily sales
    daily = defaultdict(float)
    for s in sales:
        d = s.get("date", "")[:10]
        daily[d] += to_usd(s["amount"], s.get("currency", "USD"), s.get("rate", fc_rate))
    daily_series = [{"date": d, "value": round(v, 2)} for d, v in sorted(daily.items())]

    return {
        "month": month,
        "revenue": round(revenue, 2),
        "purchases": round(purchases, 2),
        "grossProfit": gross_profit,
        "supplierPayments": round(supplier_pay, 2),
        "drawings": round(drawings, 2),
        "netProfit": net_profit,
        "cashFlow": cash_flow,
        "billsCount": len(bills),
        "salesCount": len(sales),
        "paymentsCount": len(payments),
        "topSuppliers": top,
        "dailySales": daily_series,
    }


@api_router.get("/reports/daily-summary")
async def daily_summary(date: str):
    """date format: YYYY-MM-DD. Returns single-day totals for quick WhatsApp sharing."""
    settings = await db.settings.find_one({"_id": "app"}) or {}
    fc_rate = settings.get("fcRate", 1.0) or 1.0

    def to_usd(amount, currency, rate):
        if currency == "USD":
            return float(amount)
        r = rate or fc_rate or 1.0
        return float(amount) / r if r else 0.0

    start = date
    q = {"date": {"$gte": start, "$lt": start + "\uffff"}}  # date-prefix match

    bills = await db.bills.find(q, {"_id": 0}).to_list(1000)
    sales = await db.sales.find(q, {"_id": 0}).to_list(1000)
    payments = await db.payments.find(q, {"_id": 0}).to_list(1000)

    sup_map = {s["id"]: s["name"] for s in await db.suppliers.find({}, {"_id": 0}).to_list(500)}

    rev = sum(to_usd(s["amount"], s.get("currency", "USD"), s.get("rate", fc_rate)) for s in sales)
    purch = sum(to_usd(b["amount"], b.get("currency", "USD"), b.get("rate", fc_rate)) for b in bills)
    sup_pay = sum(to_usd(p["amount"], p.get("currency", "USD"), p.get("rate", fc_rate))
                  for p in payments if p.get("type") == "supplier_payment")
    draw = sum(to_usd(p["amount"], p.get("currency", "USD"), p.get("rate", fc_rate))
               for p in payments if p.get("type") == "drawing")

    return {
        "date": date,
        "revenue": round(rev, 2),
        "purchases": round(purch, 2),
        "grossProfit": round(rev - purch, 2),
        "supplierPayments": round(sup_pay, 2),
        "drawings": round(draw, 2),
        "netCash": round(rev - sup_pay - draw, 2),
        "billsCount": len(bills),
        "salesCount": len(sales),
        "paymentsCount": len(payments),
        "suppliers": [{"name": sup_map.get(b.get("supplierId", ""), "Unknown"), "amount": to_usd(b["amount"], b.get("currency", "USD"), b.get("rate", fc_rate))} for b in bills],
    }


@api_router.get("/backup/export")
async def backup_export():
    """Full DB dump as JSON for backup/share/restore."""
    collections = ["suppliers", "bills", "sales", "payments", "inventoryChecks"]
    data = {}
    for c in collections:
        data[c] = await db[c].find({}, {"_id": 0}).to_list(20000)
    s = await db.settings.find_one({"_id": "app"}, {"_id": 0}) or {}
    data["settings"] = s
    data["_meta"] = {
        "app": "ledgr",
        "version": 1,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
    }
    return data


class BackupPayload(BaseModel):
    suppliers: Optional[List[dict]] = None
    bills: Optional[List[dict]] = None
    sales: Optional[List[dict]] = None
    payments: Optional[List[dict]] = None
    inventoryChecks: Optional[List[dict]] = None
    settings: Optional[dict] = None
    mode: Optional[Literal["replace", "merge"]] = "replace"


@api_router.post("/backup/import")
async def backup_import(body: BackupPayload):
    """Restore from a backup file. mode=replace wipes then inserts, mode=merge appends by id (upsert)."""
    mode = body.mode or "replace"
    counts = {}
    mapping = [
        ("suppliers", body.suppliers),
        ("bills", body.bills),
        ("sales", body.sales),
        ("payments", body.payments),
        ("inventoryChecks", body.inventoryChecks),
    ]
    for name, items in mapping:
        if items is None:
            continue
        if mode == "replace":
            await db[name].delete_many({})
            if items:
                await db[name].insert_many(items)
            counts[name] = len(items)
        else:
            n = 0
            for it in items:
                if "id" in it:
                    await db[name].update_one({"id": it["id"]}, {"$set": it}, upsert=True)
                    n += 1
            counts[name] = n
    if body.settings is not None:
        s = dict(body.settings)
        s.pop("_id", None)
        await db.settings.update_one({"_id": "app"}, {"$set": s}, upsert=True)
        counts["settings"] = 1
    return {"ok": True, "mode": mode, "imported": counts}


# ---------- Periods (Close Period) ----------
@api_router.get("/periods")
async def list_periods():
    return await db.periods.find({}, {"_id": 0}).sort("closed_at", -1).to_list(500)


@api_router.post("/periods/close")
async def close_period(body: ClosePeriodIn):
    """Snapshot the current period, save as a closed period, and start fresh with the closing values as new opening."""
    d = await dashboard()
    now_date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    period_start = d.get("periodStart", "1970-01-01")

    # Closing cash uses current computed cash (which already includes opening)
    closing_cash = float(d.get("cash", 0.0))
    actual_stock = float(body.actualStock)

    period = ClosedPeriod(
        startDate=period_start,
        endDate=now_date,
        openingInventory=float(d.get("openingInventory", 0.0)),
        openingCash=float(d.get("openingCash", 0.0)),
        totalSales=float(d.get("totalSales", 0.0)),
        totalPurchases=float(d.get("totalPurchases", 0.0)),
        grossProfit=float(d.get("grossProfit", 0.0)),
        managerCommissionPct=float(d.get("managerCommissionPct", 0.0)),
        commission=float(d.get("commission", 0.0)),
        drawings=float(d.get("drawings", 0.0)),
        supplierPayments=float(d.get("supplierPayments", 0.0)),
        netProfit=float(d.get("netProfit", 0.0)),
        closingInventory=actual_stock,
        closingCash=closing_cash,
        notes=body.notes or "",
    )
    await db.periods.insert_one(period.model_dump())

    # Also record a normal inventory check for continuity
    inv = InventoryCheck(
        date=now_date,
        expectedStock=float(d.get("inventoryValue", 0.0)),
        actualStock=actual_stock,
        variance=round(actual_stock - float(d.get("inventoryValue", 0.0)), 2),
        notes=f"Period close: {period.startDate} → {period.endDate}",
    )
    await db.inventoryChecks.insert_one(inv.model_dump())

    # Bump period start and opening balances
    next_day_dt = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    from datetime import timedelta
    next_day = (next_day_dt + timedelta(days=1)).strftime("%Y-%m-%d")
    await db.settings.update_one(
        {"_id": "app"},
        {"$set": {
            "currentPeriodStart": next_day,
            "openingInventory": actual_stock,
            "openingCash": closing_cash,
        }},
        upsert=True,
    )

    return period.model_dump()


# ---------- Danger zone ----------
@api_router.post("/reset")
async def reset_all(confirm: str = ""):
    """Wipe all data. Requires ?confirm=YES query param."""
    if confirm != "YES":
        raise HTTPException(400, "Reset requires ?confirm=YES")
    for c in ["suppliers", "bills", "sales", "payments", "inventoryChecks", "periods"]:
        await db[c].delete_many({})
    # Preserve Gemini key + FC rate; reset only accounting-related settings
    await db.settings.update_one(
        {"_id": "app"},
        {"$set": {
            "currentPeriodStart": "1970-01-01",
            "openingInventory": 0.0,
            "openingCash": 0.0,
            "managerCommissionPct": 0.0,
        }},
        upsert=True,
    )
    return {"ok": True, "message": "All data reset. Settings (Gemini key + FC rate) preserved."}


app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
