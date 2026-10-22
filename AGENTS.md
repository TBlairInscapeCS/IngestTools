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

## Extension verification

- Syntax check (no node on this machine):
  `osascript -l JavaScript /tmp/syncheck.jxa` or equivalent `new Function` parse.
- Regression gate: `cd extension && osascript -l JavaScript test_fixtures.js`
  (expect 76/76).
- `test_engine.js` is a diagnostic demo, not assertions.
