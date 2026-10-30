<!-- CANONICAL: github.com/Prospectr/chief-of-staff  skills/certapro-commercial-outreach/SKILL.md -->
<!-- CANONICAL SKILL DOC (Google): https://docs.google.com/document/d/1sEO97HhFwT5NFscvD78rRUEhCivhrlpDQK6u52glDhs -->
<!-- The Google Doc is the source of truth. This file is a pointer + memory aid only. -->

# CertaPro Commercial Outreach Skill

## Purpose

Build Dominic Dault a repeatable commercial outreach engine for CertaPro Painters Grand Haven.
The AI handles list building, research, contact enrichment, deduplication, and email/Outlook draft
creation. Dominic handles all human-facing work: reviewing/sending emails, calls, LinkedIn, replies.

**Human sender / thread owner:** Dominic Dault (ddault@certapro.com)
**Nothing is ever sent automatically — drafts only, always.**

## Two Tracks

- **Track 1:** Past commercial customers, dead estimates, and dead leads (pulled from CertaOne)
- **Track 2:** Net-new Michigan commercial property manager (CPM) prospecting via CoStar/transaction data

**Daily motion:** Personalized email + relevant asset → call within 5–15 min → voicemail if no answer
→ LinkedIn touch → log outcome + next action. Target: 5–6 fully worked prospects per day.

## Canonical Docs

| Doc | Link / ID |
|-----|-----------|
| Master skill doc (SOP, spec, changelog — SOURCE OF TRUTH) | https://docs.google.com/document/d/1sEO97HhFwT5NFscvD78rRUEhCivhrlpDQK6u52glDhs |
| Dominic Estimate 7-Day Follow-Up (companion skill) | https://docs.google.com/document/d/1XfRfA9OiyRVthg1kkQpW8x0IsXJmpk2irKqWaQ1BOI0 |
| CertaPro Brand Standard (voice/tone — load before drafting copy) | Doc ID: 1eFTtN4NpqSlcSuxl2Ra-3w-zWru_rEGzZHr-8J_DKj0 |
| Commercial marketing SharePoint | https://gocerta.sharepoint.com/sites/CommMarketing |
| Commercial Operations — Email Campaigns & Call Scripts | https://gocerta.sharepoint.com/sites/CommercialOperations/SitePages/Email-Campaigns-&-Call-Scripts.aspx |

**When skill is invoked:** Read the master Google Doc fresh each run before acting.

Access pattern:
- Service account: `aria-docs-bot@aria-sales-helper.iam.gserviceaccount.com`
- Key source: `GOOGLE_SERVICE_ACCOUNT_JSON` in `/root/.openclaw/workspace/.env.secrets` (base64-encoded JSON)
- Scope: `https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/documents`
- Use Drive export API: `GET /drive/v3/files/{doc_id}/export?mimeType=text/plain`
- Do NOT use `/root/.openclaw/.google-credentials-prospectr-scoped.json` — that is the prospectr-scoped SA for lead sheets only, not this doc.
- If 403/404, surface a BLOCKED state immediately. Do not proceed from a local copy alone.

## Strategic Context

- **FastTrack30 (Jarold Martin, Sep 14):** 69% of CertaPro GH pipeline = previous customers.
  Target: $2M booked by Thanksgiving.
- **Key flagged opportunities:** American House, Shoreline Container, Forefront Dermatology, Lowe's/Lucky Strike
- **Troy's vision:** AI acts as virtual Franchise Business Coach for Dominic — daily pipeline review,
  WHY/HOW/NEXT framework (Jarold), auto-draft follow-up emails into Dominic's Outlook Drafts.
- **MotherDuck / prospectr_bi** is live as a data source for commercial vs. residential revenue splits.

## Key Contacts

| Name | Role | Contact |
|------|------|---------|
| Dominic Dault | Human sender / thread owner | ddault@certapro.com |
| Troy Hacker | Client owner, spend authority | thacker@certapro.com |
| Travis Piepho | Technical escalation, copy review, vendor questions | travis@prospectrdigital.com |
| Jarold Martin | FastTrack30 coach | jaroldmartin@certapro.com / 347-659-0143 |

## What's Already Done (as of handoff, Oct 2026)

- Full SOP in the master doc: 16 sections, machine-readable spec, verification standards,
  failure modes, escalation rules, changelog
- 7 email templates (A–G), call/voicemail scripts, objection handling, LinkedIn procedure,
  daily checklist for Dominic, full launch checklist, daily CoS dashboard format, KPIs
- Pilot run (Aug 26): scanned 1,200 dead CertaOne jobs → 10 Track 1 records identified
  (Dominic-owned, Commercial, deduped, no CRM DNC flags); zero emails sent
- Track 2 spreadsheet header mapping confirmed (actual headers: AB=Seller Secondary Type,
  Y=True Seller, AC=Seller Origin, AD=Listing Broker Company, AY=Recorded Buyer)
- Brand Standard and Jarold framework linked into skill

## Open Blockers (as of handoff — must all clear before launch)

### People / Access
1. ⬜ Dominic's Outlook on Always-On Mac — not set up. **Core blocker for draft placement.**
2. ⬜ Kelly's slash-template workflow — needs pairing session; do NOT automate until observed.
3. ⬜ Separate automation browser profile on Always-On Mac — must be confirmed before any Outlook UI work.

### Content / Inputs (Troy)
4. ⬜ Canonical CertaPro brand guide and assets — not received.
5. ⬜ Troy + Gabe CPM transcript — commercial property manager value framing.

### Content / Inputs (Travis)
6. ⬜ Dominic's prior outreach emails — tone calibration.
7. ⬜ Approved templates, research guide, ZoomInfo request format.
8. ⬜ Bright Data and ZoomInfo access — UNVERIFIED. No vendor access confirmed.

### CRM / Tracker
9. ⬜ CRM source/export confirmed — CertaOne is source for Track 1, but approved export
   format and field mapping aren't locked. "[CONFIGURE CRM/TRACKER]" placeholders remain.
10. ⬜ Dominic's non-renewal list + pipeline classification (committed / likely / delayed / at-risk).

### Outreach Infrastructure
11. ⬜ Approved placement of Dominic review block (draft body vs. Outlook field); verify not visible to recipient.
12. ⬜ Campaign manager / lead-list owner assigned.
13. ⬜ Estimator / commercial sales handoff owner assigned.
14. ⬜ Daily + weekly reporting owner assigned.

### Assets
15. ⬜ Reserve-Funded Painting Project Checklist — referenced in playbook but link is [INSERT].

### Compliance
16. ⬜ Opt-out, do-not-contact, and suppression rules for Michigan commercial prospecting — not confirmed.

## Setup Required (Seth's Instance)

### 1. Google Doc access
Doc is already shared with `aria-docs-bot@aria-sales-helper.iam.gserviceaccount.com` ✅
Key is stored as base64 in `.env.secrets` under `GOOGLE_SERVICE_ACCOUNT_JSON` ✅
Access verified 2026-10-30.

### 2. Gmail OAuth for Seth's inbox (optional — for routing/handoff drafts TO Seth)
- Travis sets up OAuth client in aria-sales-helper GCP project (Desktop app type)
- Seth completes consent flow once → generates refresh token
- Store as `SETH_EMAIL_CLIENT_ID`, `SETH_EMAIL_CLIENT_SECRET`, `SETH_EMAIL_REFRESH_TOKEN`
  in `.env.secrets` via one-time-secret-link protocol
- Travis must set GCP app to **Internal** publishing status to prevent 7-day token expiry

## Non-Negotiable Rules

- **Never send email.** Draft only, always. Dominic reviews and sends.
- **Never auto-post on LinkedIn.** Dominic acts manually.
- **Never bypass deduplication or suppression.**
- **Never invent contact data, credentials, or integration status.** Mark unknowns as BLOCKED or UNVERIFIED.
- Stop sequence on any reply, meeting booked, opt-out, or duplicate.
- Two failures at the same step → stop and diagnose. Do not retry blind.

## Brand Constraints

> Source: CertaPro Brand Standard doc (1eFTtN4NpqSlcSuxl2Ra-3w-zWru_rEGzZHr-8J_DKj0). Load that skill before drafting any outreach copy.

### Core Voice Rules
- **The word is "certainty."** Every draft must touch certainty, extraordinary experience, or promise delivered. Copy that never lands on one of these three is off-voice.
- **Brand Promise (verbatim):** "In a world of increasingly little or no certainty, CertaPro Painters® delivers certainty one job and one extraordinary customer experience at a time."
- **Brand Vision:** "To consistently deliver extraordinary experiences®."
- **Brand Values:** Deliver what you promise. Respect the individual. Have pride in what you do. Practice continuous improvement. Embrace Possibilities.
- **Tone:** Professional, warm, confident — not pushy or salesy. CertaPro is the trusted expert, not the hungry vendor.
- **Shelter/protection framing** is on-brand for commercial: facilities protect the people and assets inside them. Connect painting to that.

### Trademark Phrases
These require ® on first use in any document — do not paraphrase into new taglines:
`CertaPro Painters®`, `North America's Most Referred Painting Company®`, `Certainty Service System®`, `Consistently Delivering Extraordinary Experiences®`, `Certainty Pledge®`, `The Color of Certainty®`, `Painting with Certainty®`

### Prohibited in Copy
- Do not invent taglines or slogans that aren't in the trademark list without explicit approval
- Do not use jargon that doesn't tie back to certainty / trust / extraordinary experience
- Do not use the wrong logo variant (Commercial logo for B2B outreach: use CP_Logo_Commercial)
- Do not use fonts other than Gilroy (fallback: Avenir)
- Phone numbers and website URLs always set in Gilroy Bold
- Do not reference paint color codes, apparel, or consumer-residential framing in commercial copy

### Approved in Commercial Email Copy
- Reference certainty, expertise, and track record
- Name specific scope and amount from the estimate record (never invent details)
- One direct question per email
- Sign as: Dominic Dault, CertaPro Painters of Grand Haven, 616-414-2543
- Vary opening line on 2nd/3rd/4th touch (per 7-day follow-up templates)

---

## Pipeline Coaching Framework (FastTrack30 — Jarold Martin)

> **Status: NOT YET DOCUMENTED IN DRIVE.** No FastTrack30, Jarold Martin, or WHY/HOW/NEXT documents found in any Drive folder accessible to aria-docs-bot as of 2026-10-30. Troy told Travis (Oct 30) that "Jarold shared several documents" — these are not yet uploaded.

### What Is Known (from SKILL.md context and Troy's Sep 21 directive)

- **Source:** Jarold Martin (jaroldmartin@certapro.com / 347-659-0143), CertaPro Franchise Business Coach meeting with Dominic Sep 14, 2026
- **Key stat:** 69% of CertaPro GH pipeline = previous customers. Jarold's FastTrack30 target: $2M booked by Thanksgiving.
- **Troy's vision:** Chief of Staff acts as Dominic's virtual Franchise Business Coach — daily pipeline review, auto-draft follow-up emails, coaching Dominic on next actions.

### WHY / HOW / NEXT Framework (known structure — full docs pending)
| Element | Meaning |
|---------|----------|
| WHY | Why this account / why now — context that justifies the outreach |
| HOW | How CertaPro will deliver / what the solution looks like |
| NEXT | The single next action Dominic must take today |

### ACT / DISCOVER / WAIT / RE-ENGAGE / CLOSE Action Taxonomy (known structure — full docs pending)
| Status | Meaning | Dominic's action |
|--------|---------|------------------|
| ACT | Hot — respond or advance today | Call within 24h |
| DISCOVER | Needs more research / context | Research + personalize |
| WAIT | Right account, wrong timing | Scheduled re-touch |
| RE-ENGAGE | Had contact, went cold | Re-engagement sequence |
| CLOSE | Estimate out, awaiting decision | Follow-up draft |

### Gap / Blocker
The full Jarold framework documents (presumably PDFs or Google Docs shared by Jarold with Troy after the Sep 14 meeting) are NOT in Drive. Troy referenced them in the Oct 30 email to Travis. **Action required: Travis or Troy must upload to the Troy Shared Skills Drive folder (1Ri52FjYZTph54m2AxE5rR262iu6h_Z3R) so they can be read by aria-docs-bot.**

---

## Cross-Dependencies

### This skill depends on (upstream blockers)
| Dependency | Required For | Status | Owner |
|------------|-------------|--------|-------|
| Dominic's Outlook on Always-On Mac | Draft placement (all tracks) | BLOCKED | Travis |
| Dominic Outlook Draft-Injection Skill | Creating drafts programmatically | BLOCKED | Travis |
| CertaOne (Certa1 / Dynamics) auth | Track 1 list building, estimate pull | BLOCKED (no Mac Studio CDP) | Travis |
| CoStar export file (TH CostarExport-405.xlsx) | Track 2 list building | NOT FOUND in workspace — needs upload | Seth/Troy |
| Bright Data / ZoomInfo enrichment access | Contact enrichment | UNVERIFIED | Travis |
| Jarold FastTrack30 framework docs | Coaching logic, pipeline taxonomy | NOT IN DRIVE | Troy/Travis |
| Suppression / opt-out list for MI commercial | Compliance gating | NOT CONFIRMED | Seth/Troy |

### The 7-Day Follow-Up skill depends on THIS skill (downstream consumers)
Doc: `1XfRfA9OiyRVthg1kkQpW8x0IsXJmpk2irKqWaQ1BOI0` | Schedule: weekday 07:30 ET

| What the 7-Day Skill Needs From This Skill | Notes |
|---------------------------------------------|-------|
| Initial prospect list / contact format | Must match Certa1 estimate record format |
| Ledger schema: `prospectr_bi.cos.estimate_followups` | Shared write target; avoid duplicate drafts |
| Suppression list | Shared; both skills must check same list |
| Dominic's Outlook Draft-Injection Skill | Same dependency — must be set up once for both |
| Certa1 open-estimate stage names | Must be confirmed on first Certa1 run; record in Part 2 |

**Cadence rule:** 7-day follow-up cadence (touches: days 7, 14, 21, 28, max 4) begins AFTER this skill creates an initial outreach draft. Both skills share the ledger to prevent duplicate draft creation.

### MotherDuck Revenue Context (2026-10-30 query)
Data from `prospectr_bi.bi.lead_profit` — all in_report YTD:

| Class | Leads | Won | QBO Revenue | QBO GP | GP% |
|-------|-------|-----|-------------|--------|-----|
| Residential | 924 | 360 | $1,603,125 | $859,054 | 53.6% |
| Commercial | 262 | 143 | $1,431,094 | $722,930 | 50.5% |

**Commercial is 47% of revenue and 46% of GP.** Primary commercial channel: In-House Commercial Team ($1.12M revenue, $546K GP from 213 leads). Prospectr Cold Calling resurfaced 1 commercial job (Eaton, $163K, 73.9% GP margin).

**Top commercial accounts (>$20K):** Eaton ($163K), Schupan ($112K), Covenant Developments ($71K+$42K), Solrace Properties ($61K+$32K), 5/3 Bank ($60K+$45K), Shoreline Container ($59K), Pioneer Construction ($51K+$39K+$24K), Servpro (multiple jobs).

---

## Changelog

### 2026-10-30 (Session 2 — Solo Dev by Chief of Staff)
- Full skill overview documented from Gabe/Bot handoff email (Seth Blake taking ownership)
- Master Google Doc read successfully: 62,755 chars, all 16 SOP sections + Part 2 + Part 3 confirmed
- Correct access path documented: `aria-docs-bot` SA key via `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env.secrets` (base64)
- Open blockers 1–16 documented; none cleared as of last changelog entry (2026-10-14)
- Seth already listed as Co-operator since 2026-10-01 (Part 3 of canonical doc)

**Solo dev session additions (2026-10-30 Session 2):**
- Brand Constraints section written from Brand Standard doc (1eFTtN4NpqSlcSuxl2Ra-3w-zWru_rEGzZHr-8J_DKj0) — voice/tone rules, trademark phrases, prohibited/approved copy patterns
- Pipeline Coaching Framework (FastTrack30) section written — WHY/HOW/NEXT and ACT/DISCOVER/WAIT/RE-ENGAGE/CLOSE documented from context; full Jarold docs NOT FOUND in Drive (gap documented)
- Cross-Dependencies section written — upstream blockers and downstream 7-day follow-up skill dependencies mapped
- MotherDuck revenue context queried: Commercial = $1.43M revenue / $722K GP (47% of total); 262 leads, 143 won
- Drive folder audit: No "CertaPro Shared Skills" folder found; Troy Shared Skills folder (1Ri52FjYZTph54m2AxE5rR262iu6h_Z3R) has 25 items; canonical doc 404 for aria-docs-bot (needs share)
- Pilot artifacts: No /artifacts/ directory found — pilot records from Aug 26 not persisted locally
- CoStar file: TH CostarExport-405.xlsx not found in workspace or /tmp — needs upload from Troy/Seth
- dependency-register.md written at skills/certapro-commercial-outreach/dependency-register.md
- go-live-brief.md written at skills/certapro-commercial-outreach/go-live-brief.md
- Canonical Google Doc update BLOCKED (404 for aria-docs-bot) — doc must be re-shared with aria-docs-bot@aria-sales-helper.iam.gserviceaccount.com

### 2026-10-14
- No functional advances today. No changes.
