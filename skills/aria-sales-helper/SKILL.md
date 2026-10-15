<!-- CANONICAL: github.com/Prospectr/chief-of-staff  skills/aria-sales-helper/SKILL.md -->

# ARIA Sales-Helper Skill

## Changelog

### 2026-10-14
- **recording no-stop** (aria_recording_no_stop_impl): 18 failure modes fixed across 3 layers
  - Server commit fce5a39: append-mode audio on reconnect, no socket-close finalize, Deepgram KeepAlive 5s, meeting revival
  - Web commit c5831e4: AudioContext resume on visibility, wake lock, mic track recovery, nav guard, indefinite retry + 10s jitter
  - Mobile OTA 36d5fcd8: background no longer ends meeting, ChunkedPcmStreamer reconnect, indefinite retry + armPromise reset
  - Still needed (iOS): UIBackgroundModes audio — requires native EAS build; quota exhausted until Nov 1
- **service worker**: updated (Oct 13 remediation batch)
- **test suite**: 382/382 web tests passing (commit 49b345c — Node 26 localStorage mock, coaching-waiting fixture, is_owner_session guard)
- **CI pipeline**: ci-add-workflow branch ready; blocked on workflow scope for GHCERTAPRO_PAT
