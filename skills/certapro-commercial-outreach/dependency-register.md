# CertaPro Commercial Outreach — Dependency Register

**Last updated:** 2026-10-30  
**Session:** Solo dev run by Chief of Staff per Seth Blake directive  
**Source:** Canonical Google Doc blockers list (as of last verified read 2026-10-30) + session findings

---

## Status Key
- 🔴 BLOCKED — nothing can proceed without this
- 🟡 UNVERIFIED — may exist, not confirmed
- 🟠 MISSING — confirmed not present, needs action
- ⬜ NOT STARTED — ready to begin once predecessor clears

---

## Blockers

| # | Blocker | Owner | What Specifically Is Needed | Status | Notes |
|---|---------|-------|----------------------------|--------|-------|
| 1 | Dominic's Outlook on Always-On Mac | Travis | Travis must configure Dominic's Outlook account on the Always-On Mac so draft-injection can place drafts without Dominic being at his desk. This is the single most critical unlock. | 🔴 BLOCKED | Core blocker for ALL outreach. Nothing sends without this. Troy emailed Travis Oct 30 re: coaching vision — this setup must be part of that conversation. |
| 2 | Separate automation browser profile on Always-On Mac | Travis | A dedicated Chrome/Edge profile for the automation bot so it doesn't conflict with Dominic's active session. Must be confirmed before any Outlook UI work. | 🔴 BLOCKED | Depends on blocker 1 being addressed. |
| 3 | Kelly's slash-template workflow pairing session | Travis/Seth | Need a live observation session with Kelly to confirm the slash-template workflow before automating it. Do NOT automate this until observed. | ⬜ NOT STARTED | Not critical-path for first outreach launch but required before full automation. |
| 4 | Canonical CertaPro brand guide and assets from Troy | Troy | Troy needs to provide official brand guide assets for commercial email templates. Brand Standard doc (1eFTtN4NpqSlcSuxl2Ra-3w-zWru_rEGzZHr-8J_DKj0) is accessible and has been integrated into SKILL.md as of 2026-10-30. | 🟡 PARTIAL | Brand Standard doc read and rules extracted 2026-10-30. CP_Logo_Commercial.zip exists in Troy Shared Skills folder. Core voice rules documented. Consider this partially cleared for copy purposes; physical assets TBD. |
| 5 | Troy + Gabe CPM transcript — commercial property manager value framing | Troy | Troy and Gabe have a recorded call discussing how to frame value for CPMs. This should inform email templates B–E. | 🟠 MISSING | Not in Drive, not in workspace. Seth to ask Troy for transcript or summary. |
| 6 | Dominic's prior outreach emails — tone calibration | Travis | Need 5–10 past Dominic commercial emails to calibrate tone for AI-drafted copy. | 🟠 MISSING | Not provided. Travis to pull from Dominic's Sent Items. |
| 7 | Approved templates, research guide, ZoomInfo request format | Travis | Travis to provide: (a) any approved email template language, (b) commercial research guide, (c) ZoomInfo request format Dominic uses for enrichment. | 🟠 MISSING | Not provided. Required before first live draft. |
| 8 | Bright Data and ZoomInfo access | Travis | No vendor access confirmed. Need credentials or API keys for contact enrichment on Track 2 net-new prospects. | 🟡 UNVERIFIED | Travis owns vendor relationships. Seth should ask status in next Travis conversation. |
| 9 | CertaOne export format and field mapping (Track 1) | Travis/Seth | CertaOne is confirmed source for Track 1 (past commercial customers, dead estimates). But the approved export format and CRM field mapping are not locked. "[CONFIGURE CRM/TRACKER]" placeholders remain in the skill spec. | 🔴 BLOCKED | Mac Studio CDP access (for CertaOne screen scraping) requires an authorized session — not attempted. Field mapping documented from pilot context only (pilot Aug 26 found 10 records from 1,200 jobs). |
| 10 | Dominic's non-renewal list + pipeline classification | Dominic/Troy | Need Dominic's working list of accounts classified as: committed / likely / delayed / at-risk. This is the input for FastTrack30 coaching. | 🟠 MISSING | Not in any file found. Seth to ask Troy/Dominic directly. |
| 11 | Approved placement of Dominic review block | Travis | Where exactly does the "Dominic review" block appear in the draft? In the email body (visible risk) or as an Outlook field/note? Must be confirmed so it's never visible to the recipient. | ⬜ NOT STARTED | Design decision. Travis and Seth should align on this before first draft. |
| 12 | Campaign manager / lead-list owner assigned | Seth/Troy | Someone must own the commercial prospect list day-to-day — adding, removing, updating records. This is not currently assigned. | 🟠 MISSING | Likely Seth (CoS) or Troy. Needs explicit assignment. |
| 13 | Estimator / commercial sales handoff owner assigned | Troy/Dominic | When a prospect says yes, who handles the estimate handoff process? Needs a named owner. | 🟠 MISSING | Presumably Dominic, but not formalized. |
| 14 | Daily + weekly reporting owner assigned | Seth/Troy | Who receives the daily outreach summary and weekly KPI report? Format confirmed (CoS dashboard format in skill doc), but recipient list and delivery method not finalized. | 🟠 MISSING | Dominic gets daily summary per skill spec. Troy should be on weekly. Format in canonical doc. |
| 15 | Reserve-Funded Painting Project Checklist | Troy | Referenced as a key asset in the commercial playbook (send with initial outreach to facility managers). Link is [INSERT] in the skill doc — actual document not uploaded. | 🟠 MISSING | Jarold or Troy should have this. Add to the "ask Troy" list. |
| 16 | Opt-out / do-not-contact / suppression rules for Michigan commercial prospecting | Seth/Travis | Michigan B2B suppression rules, CAN-SPAM compliance for commercial email, and internal DNC list not confirmed. Required before any Track 2 cold outreach. | 🔴 BLOCKED | Legal/compliance gate. Must be cleared before Track 2 launches. Track 1 (past customers) is lower risk but still needs review. |

---

## Additional Blockers Found This Session (2026-10-30)

| # | Blocker | Owner | What's Needed | Status |
|---|---------|-------|---------------|--------|
| 17 | Jarold FastTrack30 framework documents | Troy/Travis | Troy told Travis (Oct 30 email) that "Jarold shared several documents following my meeting with Dominic." These are NOT in any Drive folder accessible to aria-docs-bot. Must be uploaded to Troy Shared Skills folder (1Ri52FjYZTph54m2AxE5rR262iu6h_Z3R). Full WHY/HOW/NEXT and ACT/DISCOVER/WAIT/RE-ENGAGE/CLOSE documented from context only. | 🟠 MISSING |
| 18 | TH CostarExport-405.xlsx — Track 2 source file | Troy/Seth | The CoStar export file (confirmed column headers: AB=Seller Secondary Type, Y=True Seller, AC=Seller Origin, AD=Listing Broker Company, AY=Recorded Buyer) is NOT in the workspace or /tmp. Must be uploaded to workspace for Track 2 processing. | 🟠 MISSING |
| 19 | Canonical Google Doc re-shared with aria-docs-bot | Seth/Travis | Doc 1sEO97HhFwT5NFscvD78rRUEhCivhrlpDQK6u52glDhs returns 404 for aria-docs-bot SA. Doc must be re-shared with aria-docs-bot@aria-sales-helper.iam.gserviceaccount.com (Editor access) so the CoS can read and update it programmatically. | 🔴 BLOCKED |
| 20 | Pilot artifacts not persisted | Seth | Aug 26 pilot (10 Track 1 records, 1,200 CertaOne jobs scanned) produced no stored artifacts. Records are lost. Track 1 pilot would need to be re-run when CertaOne access is restored. | 🟠 MISSING |

---

## Critical Path to First Live Outreach

**Minimum unlock set (must ALL clear for Track 1 launch):**
1. Blocker 1 — Dominic's Outlook on Always-On Mac (Travis)
2. Blocker 2 — Automation browser profile (Travis)
3. Blocker 9 — CertaOne export / field mapping (Travis)
4. Blocker 16 — Suppression/compliance rules (Seth)
5. Blocker 19 — Canonical doc re-shared with aria-docs-bot (Seth)

**Additional for Track 2 (net-new prospecting):**
- Blocker 8 — Bright Data / ZoomInfo (Travis)
- Blocker 18 — CoStar file upload (Troy/Seth)
- Blocker 16 — Suppression rules (applies to Track 2 especially)

---

*This register is the working basis for Seth's outreach to Travis and Troy. Seth handles those conversations separately.*
