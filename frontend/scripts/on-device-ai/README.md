# On-device Needle / Gemma

Live `codex-sol` / `Manus` are not this work. Use `codex-sol-on-device-ai` and `Manus-on-device-ai`. Restore with tags `pre-on-device-ai-codex-sol` and `pre-on-device-ai-manus`.

## Who does what

**Agent / laptop (already scripted):**

```
pip install cactus-needle
node ./scripts/on-device-ai/fetch-native.mjs
```

That pulls public `needle2.cact` (~14MB) and `libneedle.a` (~21MB) into the Android module. Fine-tune is optional quality work (`needle finetune needle-ledgr.jsonl`) and can wait.

**You (phone / EAS):** `npx expo run:android` or an EAS Android build. Metro Fast Reload cannot compile JNI.

The store APK is whoever runs that native build (you locally, or EAS in the cloud). GitHub Actions Android validation compiles; it does not publish to Play.

## Optional Gemma packs

Convert with `cactus download` and place `.cact` files in the app's `on-device-models/optional/` folder, or use Advanced Settings → Download (needs a hosted `.cact` URL).
