/**
 * Downloads public Needle 2 weights + Android arm64 engine into the Expo module.
 * Run from frontend/: node ./scripts/on-device-ai/fetch-native.mjs
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const frontend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const androidMain = path.join(frontend, 'modules', 'ledgr-native-ai', 'android', 'src', 'main');
const staging = path.join(androidMain, 'needle-native');
fs.mkdirSync(staging, { recursive: true });

function runNeedle(args) {
  const result = spawnSync('needle', args, { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    throw new Error(`needle ${args.join(' ')} failed. Install with: pip install cactus-needle`);
  }
}

runNeedle(['download', 'android-arm64', '--out', staging]);
runNeedle(['download', 'Cactus-Compute/needle2', '--out', staging]);

const arm = path.join(staging, 'android-arm64');
const assets = path.join(androidMain, 'assets');
const jni = path.join(androidMain, 'jniLibsStatic', 'arm64-v8a');
const include = path.join(androidMain, 'cpp', 'include');
fs.mkdirSync(assets, { recursive: true });
fs.mkdirSync(jni, { recursive: true });
fs.mkdirSync(include, { recursive: true });
fs.copyFileSync(path.join(staging, 'needle2.cact'), path.join(assets, 'needle2.cact'));
fs.copyFileSync(path.join(arm, 'libneedle.a'), path.join(jni, 'libneedle.a'));
fs.copyFileSync(path.join(arm, 'needle.h'), path.join(include, 'needle.h'));
console.log('Copied needle2.cact, libneedle.a, and needle.h into the Android module.');
console.log('Next: npx expo run:android   (or EAS). JS reload is not enough.');
