/**
 * Fine-tune Needle 2 on Ledgr tools using only this laptop.
 *
 * Does NOT call OpenRouter, Gemini, or any paid training API.
 * `needle finetune --generate` is forced to 0.
 *
 * Usage (from frontend/):
 *   pip install cactus-needle
 *   node ./scripts/on-device-ai/finetune-needle.mjs
 *
 * Then rebuild the APK (GitHub "Build Ledgr AI Android" or npx expo run:android).
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.join(root, '..', '..');
const jsonl = path.join(root, 'needle-ledgr.jsonl');
const lora = path.join(root, 'needle-ledgr-lora.pkl');
const cact = path.join(root, 'needle2-ledgr.cact');
const asset = path.join(frontend, 'modules', 'ledgr-native-ai', 'android', 'src', 'main', 'assets', 'needle2.cact');

function run(command, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.OPENROUTER_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  env.NEEDLE_TELEMETRY = '0';
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true, env, cwd: root });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] || ''} failed with exit ${result.status}`);
  }
}

function needleCmd() {
  if (process.env.NEEDLE) return { cmd: process.env.NEEDLE, prefix: [] };
  const probe = spawnSync('needle', ['--help'], { encoding: 'utf8', shell: true });
  if (probe.status === 0) return { cmd: 'needle', prefix: [] };
  return { cmd: 'python', prefix: ['-m', 'needle'] };
}

console.log('Ledgr Needle fine-tune (local only, no training API credits).');
run(process.execPath, [path.join(root, 'generate-needle-dataset.mjs')]);
if (!fs.existsSync(jsonl)) throw new Error('Dataset was not written: ' + jsonl);

const { cmd, prefix } = needleCmd();
run(cmd, [
  ...prefix,
  'finetune',
  jsonl,
  '--generate', '0',
  '--epochs', process.env.NEEDLE_EPOCHS || '3',
  '--batch-size', process.env.NEEDLE_BATCH || '8',
  '--val-split', '0.1',
  '--out', lora,
]);

const checkpoint = process.env.NEEDLE_CHECKPOINT || 'checkpoints/needle2.pkl';
run(cmd, [...prefix, 'build', checkpoint, '--lora', lora, '--out', cact, '--bits', '2']);

fs.mkdirSync(path.dirname(asset), { recursive: true });
fs.copyFileSync(cact, asset);
console.log(`\nInstalled Ledgr-tuned weights at:\n  ${asset}`);
console.log('Next: bake an APK from GitHub (Build Ledgr AI Android) on this branch.');
console.log('This script never called OpenRouter / generate-data.');
