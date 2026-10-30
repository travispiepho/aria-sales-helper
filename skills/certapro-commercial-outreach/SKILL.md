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

## Changelog

### 2026-10-30
- Full skill overview documented from Gabe/Bot handoff email (Seth Blake taking ownership)
- Master Google Doc read successfully: 62,755 chars, all 16 SOP sections + Part 2 + Part 3 confirmed
- Correct access path documented: `aria-docs-bot` SA key via `GOOGLE_SERVICE_ACCOUNT_JSON` in `.env.secrets` (base64)
- Open blockers 1–16 documented; none cleared as of last changelog entry (2026-10-14)
- Seth already listed as Co-operator since 2026-10-01 (Part 3 of canonical doc)

### 2026-10-14
- No functional advances today. No changes.
