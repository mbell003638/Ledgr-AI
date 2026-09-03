# On-device Needle / Gemma

Live `codex-sol` / `Manus` are not this work. Use `codex-sol-on-device-ai` and `Manus-on-device-ai`. Restore with tags `pre-on-device-ai-codex-sol` and `pre-on-device-ai-manus`.

## Fine-tune Needle (required before a store APK)

1. `node ./scripts/on-device-ai/generate-needle-dataset.mjs`
2. Install Cactus Needle CLI (`pip` / `needle` from https://github.com/cactus-compute/needle).
3. `needle finetune --data needle-ledgr.jsonl --out needle2-ledgr.cact`
4. Copy `needle2-ledgr.cact` to `modules/ledgr-native-ai/android/src/main/assets/needle2.cact`
5. Copy `libcactus_engine.so` into `modules/ledgr-native-ai/android/src/main/jniLibs/arm64-v8a/`
6. Rebuild: `npx expo run:android`
7. Golden-set gate: ≥90% exact type+required fields, zero inventory-count deletes.

Until those native files are vendored, JS still compiles and routes: local parser first, Needle when the engine is present, optional Gemma downloads, phone-speaker TTS.

## Optional Gemma packs

Convert with `cactus download` and place `.cact` files in the app's `on-device-models/optional/` folder, or use Advanced Settings → Download (needs a hosted `.cact` URL).
