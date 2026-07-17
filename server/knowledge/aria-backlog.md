
## v-next: Coaching Panel UX
- **Slow down tip cycling** — dynamic tips and next steps rotate too fast to read. Increase cycle interval so the most important ones stay visible longer before switching. Consider: 8-12 seconds per tip instead of current speed, or pause on hover/tap.
  - Requested by: Gabe Bass, 2026-07-16

## Phase 5/6 Feature Ideas (from Gabe, 2026-07-17)

### Voice Fingerprinting / Speaker Enrollment
- Each rep records a short voice sample (~30-60s) during account setup
- Sample is processed into a voice embedding (fingerprint)
- During live meetings, ARIA compares diarized speakers against enrolled rep profiles
- "Speaker 1" auto-labels to rep name; "Speaker 2" to customer
- Coaching, checklist, and DISC detection become rep-aware (knows exactly who said what)
- Implementation: speaker embedding model (pyannote, resemblyzer, or Deepgram Speaker ID add-on) + `voice_prints` DB table per user
- Requested by: Gabe Bass, 2026-07-17

---

## Phase 4+ Feature Ideas (from Gabe, 2026-07-16)

### Jargon Flagging
- Detect industry/technical jargon used by the rep that customers may not understand
- Only flag if the term hasn't been defined earlier in the conversation
- Examples to watch: PJCC, CertaOne, Certainty Pledge (unless explained), primer types, etc.

### Word Cadence Scoring
- Score the rep's speaking pace over time
- Average words per minute (WPM) — displayed post-meeting
- WPM graph over the duration of the call (are they speeding up when nervous? slowing down when closing?)
- Flag if pace is too fast or too slow for the detected DISC style

### Checklist Sequencing / Timing
- Track WHEN in the conversation each checklist item is hit (not just if)
- Flag if critical items (price range, scope confirmation) are hit too late
- Ideal sequence scoring: did the rep follow the 10+1 order?

### Post-Meeting Analytics
- All of the above rolled into a "Meeting Score" card
- Breakdowns: pacing, sequencing, coverage %, DISC adaptation quality
