# Project notes for Devin

## ingest_watch.py → launchd restart rule

`local/ingest_watch.py` runs as launchd agent `dev.ingest-watch`
(`~/Library/LaunchAgents/dev.ingest-watch.plist`, repo copy at
`local/dev.ingest-watch.plist`). Python runs the code loaded at launch,
so a running watcher never sees file changes.

**After ANY edit to `local/ingest_watch.py`, restart it:**

```bash
launchctl kickstart -k gui/$(id -u)/dev.ingest-watch
```

Verify with `launchctl print gui/$(id -u)/dev.ingest-watch` (state =
running) and `local/logs/watch.log` (logs moved beside the script for
portability). The user does not restart it — that is
the agent's responsibility as the only editor of the file.

## Keep user guidance current

Whenever an extension feature, UI element, label, default, or workflow changes,
update its user guidance in the same change:

- `README.md`: overview, job flow, dependencies, and troubleshooting as affected.
- `extension/README.md`: detailed controls and operating instructions.
- `extension/welcome.html`: welcome copy, first-run onboarding, and setup checklist.
- Relevant in-panel help/bubbles in `extension/sidepanel.html`.

Use the actual UI labels and behavior. Distinguish discovery from downloading,
preview from writing, and drafts from posting/sending. Explain trackerless paths,
client-specific naming, prerequisites, and limitations when relevant. Do not
advertise planned functionality as shipped. If a surface needs no change, review
it explicitly rather than adding unrelated text. Verify HTML/embedded JavaScript
syntax and any changed setup-check behavior before finishing.

## Extension verification

- Syntax check: `node --check extension/sidepanel.js` (Node is available at
  `/opt/homebrew/bin/node`); JXA `new Function` parsing also works.
- Regression gate: `cd extension && osascript -l JavaScript test_fixtures.js`
  (expect 146/146, including InMarket mixed row ranges, unmarked old
  confirmations, and per-row campaign metadata from column D).
- Tracker-selection integration tests: `cd extension && node test_tracker_selection.js`
  (14 tests; executes production selection, loader, storage cleanup, and Run all
  code against browser/network mocks, including asynchronous request changes).
- Trackerless reply integration tests: `cd extension && node test_trackerless_reply.js`
  (24 tests; executes Jira sign-off exclusion, Yangaroo link attachment,
  dual-silo reply (per-file commercial cid per realm),
  row-scoped rematching, email matching, reply generation, Comcast capture, local
  discovery, and resumed verification together, including ComScore/SimulMedia logs).
- Local media discovery tests: `cd local && python3 -m unittest test_local_discovery.py`
  (9 tests; fixed-root request-ID matching, duplicates, symlinks, changed files,
  batch separation, and serving without a manifest).
- Four-step journey UI tests: `cd extension && node test_journey_ui.js`
  (51 tests; filename aliases, live fill plan replacement, metadata verification,
  delayed portal cells, fill counts, model decisions, real markup/controller, manual shortcuts,
  approval boundaries, request reset, busy guards, download Stop races,
  silent Clear all, retained logs, and late-alert suppression).
- `test_engine.js` is a diagnostic demo, not assertions.
