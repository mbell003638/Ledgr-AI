#!/usr/bin/env node

const { spawnSync } = require("node:child_process");

// image-size is pulled in only by Metro, which runs while bundling trusted
// repository assets and is not shipped in the Android runtime. As of 2026-08-09
// both advisories affect every published image-size version, so npm has no
// non-breaking remediation for Expo SDK 54. Keep this exception exact and let
// every other high/critical advisory fail CI.
const ALLOWED_FINDINGS = new Set([
  "image-size:GHSA-w3rx-r6r6-pgpr",
  "image-size:GHSA-5p2g-fcmc-qvqq",
  "nanoid:GHSA-2v37-7h3g-55p8",
]);
// Metro-chain only. Owner: Ledgr maintainers. Review or remove after Expo SDK upgrade; expires 2026-11-15.
const ALLOWLIST_EXPIRES = "2026-11-15";
if (new Date() > new Date(`${ALLOWLIST_EXPIRES}T00:00:00.000Z`)) {
  console.error(`npm audit allowlist expired on ${ALLOWLIST_EXPIRES}. Re-evaluate Metro advisories or upgrade Expo.`);
  process.exit(1);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error("npm_execpath is unavailable; run this check through `npm run audit:ci`.");
  process.exit(1);
}

const audit = spawnSync(process.execPath, [npmCli, "audit", "--omit=dev", "--audit-level=high", "--json"], {
  encoding: "utf8",
  shell: false,
});

if (audit.error) {
  console.error(`Could not run npm audit: ${audit.error.message}`);
  process.exit(1);
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  console.error(audit.stderr || audit.stdout || "npm audit returned invalid JSON");
  process.exit(1);
}

const vulnerabilities = Object.entries(report.vulnerabilities || {}).filter(
  ([, vulnerability]) => ["high", "critical"].includes(vulnerability.severity),
);
if (vulnerabilities.length === 0) {
  console.log("npm audit found no high or critical production vulnerabilities.");
  process.exit(0);
}

const directAdvisories = vulnerabilities.flatMap(([packageName, vulnerability]) =>
  (vulnerability.via || [])
    .filter((via) => typeof via === "object" && via !== null)
    .map((via) => {
      const advisoryId = String(via.url || "").match(/GHSA-[\w-]+/i)?.[0] || "unknown";
      return { packageName, advisoryId, title: via.title || "Unknown advisory" };
    }),
);

const unexpected = directAdvisories.filter(
  ({ packageName, advisoryId }) => !ALLOWED_FINDINGS.has(`${packageName}:${advisoryId}`),
);

if (unexpected.length > 0 || directAdvisories.length === 0) {
  console.error("npm audit found unapproved high/critical production vulnerabilities:");
  for (const finding of unexpected.length > 0 ? unexpected : vulnerabilities.map(([packageName]) => ({ packageName, advisoryId: "unknown", title: "No root advisory was reported" }))) {
    console.error(`- ${finding.packageName}: ${finding.advisoryId} — ${finding.title}`);
  }
  process.exit(1);
}

console.warn("npm audit found only temporarily allowlisted Metro build-tool advisories:");
for (const { packageName, advisoryId, title } of directAdvisories) {
  console.warn(`- ${packageName}: ${advisoryId} — ${title}`);
}
console.warn("All other high/critical production advisories remain fatal.");
