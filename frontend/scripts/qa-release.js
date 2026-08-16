#!/usr/bin/env node
/**
 * Automated Play-release gate. Mirrors .github/workflows/test.yml and adds
 * Android identity checks. This is not a device smoke test and does not
 * replace Internal testing / Play pre-launch.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const appJson = JSON.parse(fs.readFileSync(path.join(root, "app.json"), "utf8"));
const expo = appJson.expo || {};
const android = expo.android || {};

const EXPECTED_PACKAGE = "com.ahem.ledgrai.codexsol";
const BLOCKED_PERMISSIONS = [
  "ACCESS_FINE_LOCATION",
  "ACCESS_COARSE_LOCATION",
  "READ_CONTACTS",
  "READ_SMS",
  "READ_CALL_LOG",
  "READ_EXTERNAL_STORAGE",
  "WRITE_EXTERNAL_STORAGE",
];

function fail(message) {
  console.error(`\nQA FAIL: ${message}`);
  process.exit(1);
}

function run(label, args) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    shell: false,
    env: process.env,
  });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} exited ${result.status}`);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) fail("npm_execpath is unavailable; run via `npm run qa:release`");

console.log("Ledgr Play-release QA (automated)");
console.log("This gate does not install on a phone or talk to Play Console.\n");

if (android.package !== EXPECTED_PACKAGE) {
  fail(`android.package is ${android.package}, expected ${EXPECTED_PACKAGE}`);
}
if (android.allowBackup !== false) {
  fail("android.allowBackup must be false for Play Data Safety");
}
if (!Number.isInteger(android.versionCode) || android.versionCode < 1) {
  fail("android.versionCode must be a positive integer");
}
const permissions = android.permissions || [];
const extra = permissions.filter((permission) => {
  const name = String(permission).replace(/^android\.permission\./, "");
  return BLOCKED_PERMISSIONS.includes(name);
});
if (extra.length) fail(`unexpected Android permissions: ${extra.join(", ")}`);
console.log(`Config OK: ${android.package} v${expo.version} (${android.versionCode}), backup off`);

run("ESLint", [npmCli, "run", "lint:ci"]);
run("Expo Doctor", [npmCli, "exec", "--", "expo-doctor"]);
run("Production dependency audit", [npmCli, "run", "audit:ci"]);
run("TypeScript", [npmCli, "exec", "--", "tsc", "--noEmit"]);
run("Jest", [npmCli, "exec", "--", "jest", "--ci", "--watchman=false", "--maxWorkers=2"]);

console.log("\nQA PASS: automated Play-release gate is green.");
console.log("Still required before store upload:");
console.log("- signed AAB (not *-testsigned) via Build Ledgr AI Android");
console.log("- physical-device smoke from docs/PLAY_RELEASE_CHECKLIST.md");
console.log("- Play Internal testing + pre-launch report");
process.exit(0);
