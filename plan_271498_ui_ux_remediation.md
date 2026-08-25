# Ledgr 271498 UI/UX Remediation Plan

**Project:** Ledgr Android, iOS, and web application  
**Branch:** `Manus` only  
**Reference recording:** `271498.mp4`  
**Prepared by:** Manus AI  
**Status:** Ready for implementation

## 1. Objective

Use the complete 271498 recording and its voice-over as the acceptance baseline for a focused remediation pass. The work must correct the onboarding layout, remove unintended visual artifacts without regressing the deliberate animation/glow experience, restore Quick Workspace organization controls, make long-press rearrangement deliberate, keep privacy content inside the app, and provide a proper local data-save path in addition to sharing.

The existing capability-aware persona behavior, multi-location behavior, accounting safety gates, native SQLite/V2 accounting semantics, browser-safe rendering, and the prior `ReorderableWorkspaceGrid` integration must remain intact. No change may be made to `codex-sol`.

## 2. Evidence and voice-over issue log

| ID | Recording time | Evidence and spoken request | Initial status | Acceptance criteria |
|---|---:|---|---|---|
| ONB-01 | 00:01–00:11 | The business-type selector is vertically centered in an odd position with excessive empty space above and below. | Confirmed in recording; source requires verification against current onboarding layout. | Business-type prompt and selector sit in a deliberate, top-aligned form region with consistent spacing on small and large screens. No awkward half-screen centering or unexpected scroll position. |
| ONB-02 | 00:11–00:28 | After choosing Retail Shop, the Continue action has an inconsistent gap from the lower edge. The user says the gap should not be present. | Confirmed in recording; source requires verification. | Continue is anchored in a consistent bottom action area that respects safe-area insets, keyboard state, and every onboarding step. |
| ONB-03 | 00:33–00:43 | The final Open my workspace step leaves a huge bottom gap. | Confirmed in recording; source requires verification. | Final action sits immediately after the useful content with intentional bottom spacing only; no unexplained large blank region. |
| VIS-01 | 01:00–01:32 and 03:19–03:31 | Blue/rectangular shadow boxes appear around workspace tiles and across tabs. The user specifically calls out Reports, Monthly Report, AI Assistant, Purchases, and Sales. | Prior Manus protections exist; recording requires a fresh audit against the current enabled-animation state. | No detached rectangular focus/shadow layer appears on web or native. Deliberate tile border/glow remains rounded, bounded, theme-aware, and visible only when interaction/animation settings permit it. |
| VIS-02 | 01:32–01:53 | Turning animation on restores a blue animation/glow, but the visual treatment must not bring back the unwanted boxes. | Partially addressed by existing grid integration; needs visual verification. | Animations & haptics enabled produces the intended rounded hover/press glow. Disabled or device Reduce Motion enabled produces static, non-glowing interaction without runtime errors. |
| GRID-01 | 01:58–02:19 and 03:34–03:52 | Quick Workspace is missing options such as sort by usage, sort by default, and reset to default that exist in `codex-sol`. | Confirmed: current Manus organizer panel only exposes drag instructions. | Edit mode provides understandable controls for Most Recent/usage, Frequently Used, A–Z if retained by the reference behavior, and Reset to Default. Controls reorder only currently capability-visible tiles and persist safely. |
| GRID-02 | 03:19–03:31 | Some tiles appeared not to open, but the user corrected that this was because Done had not been pressed. | Not a confirmed functional defect; treat as a discoverability requirement. | Edit mode clearly communicates that tile presses are disabled while organizing and exposes a visible Done action. Normal mode keeps every capability-visible tile navigable. |
| GRID-03 | 04:12–04:28 | Long-press rearrangement begins too quickly and needs approximately 25–30% more delay. | Confirmed; current component uses the shared motion long-press value and needs comparison to the desired threshold. | Long-press delay is increased by approximately 25–30% from the current baseline, is still comfortable on Android/iOS, and does not affect ordinary tap navigation. |
| SET-01 | 04:31–04:39 | Privacy & Data opens an external GitHub page; the user wants a small in-app page instead. | Confirmed in current Settings source: external URL navigation. | Privacy policy opens in an in-app, theme-consistent, mobile-scrollable viewer or modal. It must not silently redirect to GitHub. External source attribution may be shown as a secondary link if useful. |
| DATA-01 | 05:05–05:23 | Export currently offers sharing but no direct local save/download. The user wants both local export and share, using the ideal financial-app workflow. | Confirmed request; current export surface requires source audit. | Data-management export offers an explicit Save to Device/Download action plus Share. The local path must use platform-appropriate document/download APIs, preserve encrypted/validated backup semantics, show success/failure feedback, and never imply that a share completed when it did not. |
| CROSS-01 | Entire recording | The user asks that the fixes work across the application, not only on one screenshot, and that the animation, shadow, onboarding, workspace, privacy, and export flows remain coherent. | Required integration constraint. | Browser QA and automated tests cover the repaired flows, with no new console/runtime errors, route regressions, accounting changes, or capability-gating regressions. |

### Clarification from the recording

The apparent inability to open some workspace tiles is explicitly withdrawn by the user in the recording: the grid was still in organizing mode and the Done action had not been pressed. This item must therefore be handled as a usability/discoverability improvement rather than a false bug report.

The recording also states that the location report now appears correct. The remediation must preserve the previously verified All locations/Main Shop Reports rail and must not replace truthful browser-local reporting with claims of native location-scoped accounting.

## 3. Seven-specialist implementation team

The following seven specialist workstreams will be executed as independent review lenses, then integrated by the manager. “Agent” denotes a specialist role and review pass; all edits remain confined to branch `Manus`.

| Specialist | Responsibility | Primary files/surfaces | Deliverable |
|---|---|---|---|
| 1. Onboarding layout specialist | Reproduce ONB-01 through ONB-03 at the relevant steps and correct vertical alignment, action anchoring, safe-area, and keyboard behavior without changing onboarding semantics. | `frontend/app/onboarding.tsx`, onboarding contracts | Responsive layout patch plus focused tests. |
| 2. Visual rendering and theme specialist | Audit VIS-01/VIS-02 across light/dark themes, enabled/disabled motion, web/native branches, and shared surfaces. Remove only detached artifacts; retain deliberate rounded glow. | `ReorderableWorkspaceGrid`, `GlowPressable`, `AnimatedGlassSurface`, shared UI styles | Visual rendering patch plus platform-specific contracts. |
| 3. Workspace organization specialist | Restore GRID-01 controls from the reference behavior, including usage/recent/default ordering and safe reset, while respecting capability-visible tiles and persisted custom order. | Home dashboard, workspace grid, AsyncStorage layout state | Organizer UX and persistence patch plus ordering tests. |
| 4. Interaction and gesture specialist | Address GRID-02/GRID-03, increase long-press delay by the agreed range, preserve ordinary tap routing, edit-mode Done behavior, haptics, and Reduce Motion. | `ReorderableWorkspaceGrid`, Home callbacks, animation context | Gesture/press patch plus native-safe and web-safe interaction contracts. |
| 5. Privacy and trust specialist | Replace SET-01 external-only navigation with an in-app policy viewer that is readable, theme-aware, scrollable, and accessible. Keep policy content traceable and avoid misleading legal claims. | Settings, privacy viewer/modal, policy content | In-app privacy flow plus accessibility and navigation tests. |
| 6. Backup/export specialist | Implement DATA-01 local save/download beside share, with platform-aware handling and clear user feedback. Preserve encrypted backup, validation, restore, and accounting data integrity. | Settings/Advanced Settings, backup/export utilities, platform adapters | Save-to-device/share flow plus integrity and failure-path tests. |
| 7. Integration and accounting QA specialist | Cross-check capability gating, persona routing, multi-location reports, accounting safety, no transaction side effects, and regression coverage across all changed flows. | Home, Reports, onboarding, Settings, backup/privacy flows, test suite | Integration matrix, regression tests, and issue list for the auditor. |

## 4. Implementation phases

### Phase A — Baseline and reproduction

Record the current `Manus` commit, confirm the working tree, inspect the complete video transcript and frame log, and reproduce each confirmed issue in the browser where possible. Use source comparison with `origin/codex-sol` only as read-only reference. Do not copy unsafe shadow or responder behavior from that branch.

### Phase B — Onboarding remediation

Fix the selector’s vertical placement, the Continue action’s bottom spacing, and the final Open my workspace gap. Validate narrow mobile dimensions, larger browser dimensions, keyboard-open behavior, safe-area handling, and all onboarding steps. Confirm onboarding back behavior and capability/persona writes remain unchanged.

### Phase C — Workspace visual and interaction remediation

Audit all workspace tile states with animations off, animations on, and Reduce Motion on. Restore rounded glow/border behavior without detached web shadows. Add the organization panel controls, make Done state prominent, preserve capability filtering, preserve `/locations`, `/ask`, `/voice`, and all existing workflow routes, and increase long-press delay by approximately 25–30%.

### Phase D — Privacy and local export remediation

Build the in-app Privacy & Data viewer. Add Save to Device/Download beside Share in the data-management workflow. Validate web downloads, Android/iOS document sharing/save behavior, cancellation/failure feedback, and backup integrity. Do not alter financial posting or AI confirmation semantics.

### Phase E — Integration validation

Run focused tests, full Jest, TypeScript, lint, audit, Expo Doctor, web export, Android export, and sync-server tests. Run browser QA through onboarding, Settings, Home workspace normal/edit modes, animation toggle, Reports location rail, Privacy & Data, and export controls. Inspect the browser console for new errors.

### Phase F — Independent audit

The expert auditor reviews the issue log, source diff, tests, browser evidence, and acceptance criteria independently of the implementation team. The auditor must classify each item as **Pass**, **Fail**, **Partial**, or **Not testable in sandbox**, and must identify regressions or scope creep.

### Phase G — Audit remediation loop

Every auditor finding receives an owner, a code/test change, and a re-test. Repeat the targeted audit until all actionable findings are Pass. Any native-device-only item must be documented honestly rather than marked as passed by inference.

### Phase H — Release hygiene and delivery

Stage only intended source, test, and plan files. Exclude recordings, generated transcripts, screenshots, browser data, audit artifacts, proposals, build output, and temporary files. Commit on `Manus`, push `origin/Manus`, verify the remote SHA, and deliver the findings, implementation summary, validation matrix, and known device-testing limitations.

## 5. Acceptance matrix

| Area | Must be true before push |
|---|---|
| Onboarding | Selector and action areas are visually intentional at every step; no large unexplained gaps; keyboard/safe-area behavior remains correct. |
| Workspace visuals | No detached square/rectangular shadow boxes; rounded glow/borders remain when motion is enabled and are absent/static when disabled or reduced-motion is active. |
| Workspace organization | Usage/recent/default/reset controls are available in edit mode; reset removes the custom order; capability filtering remains authoritative. |
| Workspace interaction | Ordinary taps route correctly; Done exits organizing mode; long-press delay is increased by the requested range; web does not crash or emit responder errors. |
| Privacy | Policy opens in-app, is scrollable and accessible, and does not force an external redirect. |
| Export | Local save/download and share are both exposed; successful completion and failure/cancellation are truthful; backup integrity is preserved. |
| Accounting | No financial posting, AI confirmation, V2 SQLite, sync, or location-scoped semantics are weakened. |
| Quality | TypeScript, all tests, lint, audit, Expo Doctor, web export, Android export, sync-server tests, browser flows, and console inspection pass. |
| Git | Only `Manus` is changed and pushed; `codex-sol` remains untouched. |

## 6. Explicit exclusions

This pass does not introduce hosted services, alter the self-hosting architecture, change the accounting model, weaken the explicit AI review/confirmation gate, or claim physical Android/iOS device validation from a sandbox browser. It also does not treat the user-corrected “tile did not open while editing” observation as a confirmed navigation defect.
