#!/usr/bin/env node
/* global __dirname */
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
const ALLOWED_ANDROID_PERMISSIONS = [
  "CAMERA",
  "RECORD_AUDIO",
  "INTERNET",
];
const REQUIRED_BLOCKED_PERMISSIONS = [
  "READ_EXTERNAL_STORAGE",
  "WRITE_EXTERNAL_STORAGE",
  "SYSTEM_ALERT_WINDOW",
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

function normalizedPermissions(values) {
  return new Set((Array.isArray(values) ? values : []).map((permission) =>
    String(permission).replace(/^android\.permission\./, "")));
}

function validateAndroidConfig(expoConfig) {
  const config = expoConfig || {};
  const androidConfig = config.android || {};
  if (androidConfig.package !== EXPECTED_PACKAGE) {
    throw new Error(`android.package is ${androidConfig.package}, expected ${EXPECTED_PACKAGE}`);
  }
  if (androidConfig.allowBackup !== false) {
    throw new Error("android.allowBackup must be false for Play Data Safety");
  }
  if (!Number.isInteger(androidConfig.versionCode) || androidConfig.versionCode < 1) {
    throw new Error("android.versionCode must be a positive integer");
  }

  const configured = normalizedPermissions(androidConfig.permissions);
  const allowed = new Set(ALLOWED_ANDROID_PERMISSIONS);
  const unexpected = [...configured].filter((permission) => !allowed.has(permission));
  const missingAllowed = [...allowed].filter((permission) => !configured.has(permission));
  if (unexpected.length || missingAllowed.length) {
    const details = [
      unexpected.length ? `unexpected: ${unexpected.join(", ")}` : "",
      missingAllowed.length ? `missing: ${missingAllowed.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    throw new Error(`Android permissions must exactly match the approved set (${details})`);
  }

  const blocked = normalizedPermissions(androidConfig.blockedPermissions);
  const missingBlocked = REQUIRED_BLOCKED_PERMISSIONS.filter((permission) => !blocked.has(permission));
  if (missingBlocked.length) {
    throw new Error(`android.blockedPermissions is missing: ${missingBlocked.join(", ")}`);
  }
}

function main() {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) fail("npm_execpath is unavailable; run via `npm run qa:release`");

  console.log("Ledgr Play-release QA (automated)");
  console.log("This gate does not install on a phone or talk to Play Console.\n");
  try {
    validateAndroidConfig(expo);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  console.log(`Config OK: ${android.package} v${expo.version} (${android.versionCode}), backup off, permissions exact`);

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
}

if (require.main === module) main();

module.exports = {
  ALLOWED_ANDROID_PERMISSIONS,
  REQUIRED_BLOCKED_PERMISSIONS,
  validateAndroidConfig,
};
