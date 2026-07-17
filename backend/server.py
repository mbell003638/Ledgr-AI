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

GEMINI_MODEL = "gemini-2.5-flash"


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
        return {"googleApiKey": "", "fcRate": 1.0}
    s.pop("_id", None)
    # Mask key
    key = s.get("googleApiKey", "")
    return {"googleApiKey": key, "fcRate": s.get("fcRate", 1.0)}


@api_router.put("/settings")
async def update_settings(body: SettingsModel):
    doc = body.model_dump()
    await db.settings.update_one({"_id": "app"}, {"$set": doc}, upsert=True)
    return doc


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

    def to_usd(amount, currency, rate):
        if currency == "USD":
            return float(amount)
        r = rate or fc_rate or 1.0
        return float(amount) / r if r else 0.0

    bills = await db.bills.find({}, {"_id": 0}).to_list(5000)
    sales = await db.sales.find({}, {"_id": 0}).to_list(5000)
    payments = await db.payments.find({}, {"_id": 0}).to_list(5000)
    inv = await db.inventoryChecks.find_one({}, {"_id": 0}, sort=[("date", -1)])
    suppliers = await db.suppliers.count_documents({})

    total_purchases = sum(to_usd(b["amount"], b.get("currency", "USD"), b.get("rate", fc_rate)) for b in bills)
    total_sales = sum(to_usd(s["amount"], s.get("currency", "USD"), s.get("rate", fc_rate)) for s in sales)
    supplier_payments = sum(to_usd(p["amount"], p.get("currency", "USD"), p.get("rate", fc_rate))
                            for p in payments if p.get("type") == "supplier_payment")
    drawings = sum(to_usd(p["amount"], p.get("currency", "USD"), p.get("rate", fc_rate))
                   for p in payments if p.get("type") == "drawing")

    liabilities = round(total_purchases - supplier_payments, 2)
    inventory_value = float(inv["actualStock"]) if inv else 0.0
    cash = round(total_sales - supplier_payments - drawings, 2)
    assets = round(cash + inventory_value, 2)
    net_worth = round(assets - liabilities, 2)
    gross_profit = round(total_sales - total_purchases, 2)

    # 7-day sales trend
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
        "totalPurchases": round(total_purchases, 2),
        "totalSales": round(total_sales, 2),
        "grossProfit": gross_profit,
        "drawings": round(drawings, 2),
        "supplierPayments": round(supplier_payments, 2),
        "suppliers": suppliers,
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
        "drawings": d["drawings"],
        "netProfit": round(d["grossProfit"] - d["drawings"], 2),
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
