"""
Ledgr backend intentionally deprecated.
The app is now fully standalone — all data lives on-device in AsyncStorage
and Gemini API calls go direct from the mobile app.
This stub exists only to keep the Emergent supervisor happy.
"""
from fastapi import FastAPI
app = FastAPI()

@app.get("/api/")
async def deprecated():
    return {"status": "deprecated", "message": "Ledgr is now standalone. Backend not required."}
