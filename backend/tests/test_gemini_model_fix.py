"""Bug-fix verification: GEMINI_MODEL upgraded from 'gemini-2.5-flash' -> 'gemini-3.5-flash'.

Previously all AI endpoints failed with:
  404 NOT_FOUND — 'model models/gemini-2.5-flash is no longer available to new users'

Expected after fix:
- With a BOGUS (non-empty) x-gemini-api-key header, endpoints must return a 400 whose
  detail contains an INVALID_ARGUMENT / API_KEY_INVALID marker (proving the model
  name reached Google and the failure is now about the auth key, not the model).
- Detail must NOT contain 'no longer available' or the old model id 'gemini-2.5-flash'.
- With no header AND no saved key in settings, all AI endpoints must return 401
  with detail 'Missing Google Gemini API key. Set it in Settings.'  (regression).

Constant assertion:
- GEMINI_MODEL in /app/backend/server.py must be exactly 'gemini-3.5-flash'.
"""
import base64
import re
import pytest


BOGUS_KEY = "test_invalid_key_xxx_not_real"
BOGUS_HEADERS = {"x-gemini-api-key": BOGUS_KEY, "Content-Type": "application/json"}

# tiny valid JPEG (1x1 white pixel) for OCR endpoint
_TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy"
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA"
    "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA"
    "AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3"
    "ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm"
    "p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA"
    "AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx"
    "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK"
    "U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3"
    "uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iii"
    "gD//2Q=="
)


def _assert_is_invalid_key_error(detail: str):
    """Assert error detail is an invalid-key / auth error and NOT a model-not-found error."""
    up = detail.upper()
    # Must NOT be the old 404 model-not-found signature
    assert "NOT_FOUND" not in up, f"Unexpected NOT_FOUND in error: {detail}"
    assert "NO LONGER AVAILABLE" not in up, f"Old model deprecation error still present: {detail}"
    assert "GEMINI-2.5-FLASH" not in up, f"Reference to OLD model still present: {detail}"
    # Must look like an auth/API-key error from Google (400 INVALID_ARGUMENT / API_KEY_INVALID)
    ok = (
        "INVALID_ARGUMENT" in up
        or "API_KEY_INVALID" in up
        or "API KEY" in up
        or "PERMISSION_DENIED" in up
        or "UNAUTHENTICATED" in up
    )
    assert ok, f"Expected an invalid-key/auth error signature, got: {detail}"


# ---------- constant assertion ----------
def test_gemini_model_constant_is_3_5_flash():
    import re as _re
    with open("/app/backend/server.py", "r", encoding="utf-8") as fh:
        src = fh.read()
    m = _re.search(r'^GEMINI_MODEL\s*=\s*[\'"]([^\'"]+)[\'"]', src, _re.MULTILINE)
    assert m, "GEMINI_MODEL constant not found in server.py"
    assert m.group(1) == "gemini-3.5-flash", f"Expected gemini-3.5-flash, got {m.group(1)}"


# ---------- bug-fix verification: invalid key -> 400 auth error (not 404 model) ----------
class TestInvalidKeyReturnsAuthError:
    def test_test_key_endpoint(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/settings/test-key", headers=BOGUS_HEADERS)
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"
        detail = r.json().get("detail", "")
        _assert_is_invalid_key_error(detail)

    def test_parse_command_endpoint(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/ai/parse-command",
            headers=BOGUS_HEADERS,
            json={"text": "sold 5 sodas for 10 dollars"},
        )
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"
        detail = r.json().get("detail", "")
        _assert_is_invalid_key_error(detail)

    def test_ocr_receipt_endpoint(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/ai/ocr-receipt",
            headers=BOGUS_HEADERS,
            json={"imageBase64": _TINY_JPEG_B64, "mimeType": "image/jpeg"},
        )
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"
        detail = r.json().get("detail", "")
        _assert_is_invalid_key_error(detail)

    def test_transcribe_endpoint(self, api_client, base_url):
        # tiny bogus audio bytes b64
        audio_b64 = base64.b64encode(b"\x00" * 128).decode()
        r = api_client.post(
            f"{base_url}/api/ai/transcribe",
            headers=BOGUS_HEADERS,
            json={"audioBase64": audio_b64, "mimeType": "audio/m4a"},
        )
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"
        detail = r.json().get("detail", "")
        _assert_is_invalid_key_error(detail)


# ---------- regression: missing-key path returns 401 ----------
class TestMissingKeyReturns401:
    """Requires settings.googleApiKey to be empty (backend already reflects this)."""
    MISSING_MSG = "Missing Google Gemini API key. Set it in Settings."

    def _check_401(self, resp):
        assert resp.status_code == 401, f"Expected 401, got {resp.status_code}: {resp.text}"
        assert resp.json().get("detail") == self.MISSING_MSG

    def test_test_key_missing(self, api_client, base_url):
        r = api_client.post(f"{base_url}/api/settings/test-key")
        self._check_401(r)

    def test_parse_command_missing(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/ai/parse-command",
            json={"text": "hello"},
        )
        self._check_401(r)

    def test_ocr_receipt_missing(self, api_client, base_url):
        r = api_client.post(
            f"{base_url}/api/ai/ocr-receipt",
            json={"imageBase64": _TINY_JPEG_B64, "mimeType": "image/jpeg"},
        )
        self._check_401(r)

    def test_transcribe_missing(self, api_client, base_url):
        audio_b64 = base64.b64encode(b"\x00" * 32).decode()
        r = api_client.post(
            f"{base_url}/api/ai/transcribe",
            json={"audioBase64": audio_b64, "mimeType": "audio/m4a"},
        )
        self._check_401(r)
