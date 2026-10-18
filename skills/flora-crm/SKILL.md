<!-- CANONICAL: github.com/Prospectr/chief-of-staff  skills/flora-crm/SKILL.md -->

# FLORA CRM Skill

## RevEngine → FLORA Customer Sync

Daily cron (5:00 AM America/Chicago) pulls all GHL contacts + pipeline stages from the Freedom Flooring RevEngine location and upserts them into the FLORA customer DB.

**Script:** `/root/.openclaw/workspace/projects/certapro-graph/flora_revengine_sync.py`
**Cron ID:** `485645b4-3047-4cce-8282-57e005432796`
**GHL Location:** `z6JTGPFeJiDsu693gpHG` (Freedom Flooring)
**GHL Creds:** `/root/.openclaw/.ghl-freedom-flooring.json` (PIT, must start with `pit-`)
**FLORA DB:** `NEON_FLORA_URL` in `.env.secrets`

### FLORA `customers` table columns added by sync

| Column | Type | Notes |
|---|---|---|
| `ghl_contact_id` | TEXT | GHL contact UUID; unique index (WHERE NOT NULL). Primary dedup key. |
| `ghl_pipeline_stage` | TEXT | Stage name from the FF Sales pipeline (most recent opportunity). NULL if no opportunity. |

### Dedup logic (in priority order)
1. `ghl_contact_id` exact match
2. `LOWER(email)` match
3. Phone digits match (`regexp_replace(phone, '[^0-9]', '', 'g')`)

Contacts with no name **or** no email+phone are skipped.

### Field mapping (GHL → FLORA)

| GHL field | FLORA column |
|---|---|
| `firstName + ' ' + lastName` | `name` |
| `email` (lowercased) | `email` |
| `phone` | `phone` |
| `address1, city, state, postalCode` | `address` (comma-joined) |
| `companyName` | `company_name` |
| `id` | `ghl_contact_id` |
| Most recent opportunity `pipelineStageId` | `ghl_pipeline_stage` (resolved via STAGES map) |

New inserts: `source = 'revengine_sync'`, `created_by = NULL` (nullable FK).

### FF Sales pipeline stage map

```python
STAGES = {
    '54756fd7-e3d7-4fde-ad18-681d59dfd130': 'New Lead',
    '6a6ca350-1815-4fd7-8691-d8e6ce62132c': 'Attempting Contact',
    '8eb1562a-3526-42d7-81a7-4cb3b046f9f7': 'Connected',
    'fcb43ff0-71ed-4fc8-9558-a569f21ebfdd': 'Qualified Opportunity',
    '852af107-ad52-4b15-88a7-91ef443d90f9': 'Appointment Scheduled',
    '0a966388-d82e-4110-874f-92265836ac1c': 'Pre-Proposal Todos',      # added 2026-10-16
    '0a6aa2dc-fd34-44b3-9fda-844574bf5566': 'Proposal / Estimate Sent',
    '1fb740d1-1130-4c35-8ea3-be61729d7868': 'Follow-Up / Decision Pending',
    'd4d03289-e477-4fbd-9789-131bc334c79f': 'Won Customer',
    'ce711e87-eca9-4367-9c82-b46c3aaf5595': 'Lost / Not Now',
    '7a925045-9ea6-4a53-ad20-7d3318060c43': 'Past Customer',
    'f20ade00-c217-4a81-981d-c528d55c4102': 'Referral Partner',
}
```

### Opportunities fetch
Paginated via `GET /opportunities/search?location_id={LOCATION_ID}&pipeline_id={PIPELINE_ID}&limit=100`
Pipeline ID: `0Vv2bL0u9W47IsNmrr7T`
When a contact has multiple opportunities, the most recently updated one wins.

### Known issues / quirks
- **f-string masking:** Do not use `f'Authorization: Bearer {pit}'` in exec scripts — the `{pit}` will be masked to `***}` at write time. Use `'Authorization: Bearer ' + pit` (string concat).
- ~238 of 624 GHL contacts have no pipeline opportunity (raw leads). Their `ghl_pipeline_stage` will be NULL.
- `business_type` (residential/commercial) is NOT mapped from GHL — GHL contacts don't carry this directly.

### Initial sync stats (2026-10-18)
- GHL contacts: 624 (7 pages)
- FLORA customers inserted: 391
- Skipped: 233 (no name or no email+phone)
- With pipeline stage: 153 (Lost/Not Now: 57, Attempting Contact: 52, others: 44)

---

## Changelog

### 2026-10-18
- **RevEngine → FLORA customer sync** — daily 5am cron (ID `485645b4`)
  - Added `ghl_contact_id` and `ghl_pipeline_stage` columns to FLORA `customers`
  - Script: `flora_revengine_sync.py` (fetches contacts + opportunities, upserts by ghl_contact_id → email → phone)
  - Initial population: 391 customers from 624 GHL contacts, 153 with pipeline stage

### 2026-10-16
- **Pre-Proposal Todos** stage added to FF Sales pipeline (pos 5, ID `0a966388-d82e-4110-874f-92265836ac1c`) via GHL API PUT

### 2026-10-14
- **Room visualizer** (Seth Blake / Freedom Flooring) — commit ebf870f:
  - `ingest.py`: Mohawk PDF → master_catalog.json pipeline
  - `visualize.py`: room photo + SKU → gpt-image-1 composite (OpenAI Images Edits API)
  - `master_catalog.json`: seeded with WEK60/Madera Trace (5 colorways)
  - Next: FastAPI service on Railway wrapping /ingest and /visualize endpoints
