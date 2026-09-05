/**
 * Fine-tune Needle 2 on Ledgr tools using only this laptop.
 *
 * Does NOT call OpenRouter, Gemini, or any paid training API.
 * Saves needle-ledgr-train-ckpt.pkl every NEEDLE_CKPT_EVERY steps (default 25)
 * so a crash/reboot can resume with the same command.
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
const ckpt = path.join(root, 'needle-ledgr-train-ckpt.pkl');
const cact = path.join(root, 'needle2-ledgr.cact');
const asset = path.join(frontend, 'modules', 'ledgr-native-ai', 'android', 'src', 'main', 'assets', 'needle2.cact');

function run(command, args, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.OPENROUTER_API_KEY;
  delete env.OPENAI_API_KEY;
  delete env.GEMINI_API_KEY;
  env.NEEDLE_TELEMETRY = '0';
  env.PYTHONUNBUFFERED = '1';
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', env, cwd: root, windowsHide: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] || ''} failed with exit ${result.status}`);
  }
}

function needleCmd() {
  if (process.env.NEEDLE) return { cmd: process.env.NEEDLE, prefix: [] };
  const probe = spawnSync('needle', ['--help'], { encoding: 'utf8' });
  if (!probe.error && probe.status === 0) return { cmd: 'needle', prefix: [] };
  return { cmd: process.env.PYTHON || 'python', prefix: ['-m', 'needle'] };
}

function pythonCmd() {
  if (process.env.PYTHON) return process.env.PYTHON;
  if (process.env.NEEDLE && /needle\.exe$/i.test(process.env.NEEDLE)) {
    const sibling = process.env.NEEDLE.replace(/needle\.exe$/i, 'python.exe');
    if (fs.existsSync(sibling)) return sibling;
  }
  return 'python';
}

console.log('Ledgr Needle fine-tune (local only, no training API credits).');
if (process.env.NEEDLE_FORCE_GENERATE === '1' || !fs.existsSync(jsonl)) {
  run(process.execPath, [path.join(root, 'generate-needle-dataset.mjs')]);
} else {
  console.log('Keeping existing dataset (resume-safe): ' + jsonl);
}
if (!fs.existsSync(jsonl)) throw new Error('Dataset was not written: ' + jsonl);

const trainArgs = [
  path.join(root, 'finetune_resume.py'),
  jsonl,
  '--epochs', process.env.NEEDLE_EPOCHS || '3',
  '--batch-size', process.env.NEEDLE_BATCH || '8',
  '--max-len', process.env.NEEDLE_MAX_LEN || '256',
  '--val-split', '0.1',
  '--out', lora,
  '--ckpt', ckpt,
  '--ckpt-every', process.env.NEEDLE_CKPT_EVERY || '25',
  '--checkpoint', process.env.NEEDLE_CHECKPOINT || 'checkpoints/needle2.pkl',
];
if (process.env.NEEDLE_RESET_CKPT === '1') trainArgs.push('--reset-ckpt');
run(pythonCmd(), trainArgs);

const { cmd, prefix } = needleCmd();

const checkpoint = process.env.NEEDLE_CHECKPOINT || 'checkpoints/needle2.pkl';
run(cmd, [...prefix, 'build', checkpoint, '--lora', lora, '--out', cact]);

fs.mkdirSync(path.dirname(asset), { recursive: true });
fs.copyFileSync(cact, asset);
console.log(`\nInstalled Ledgr-tuned weights at:\n  ${asset}`);
console.log('Next: bake an APK from GitHub (Build Ledgr AI Android) on this branch.');
console.log('This script never called OpenRouter / generate-data.');
