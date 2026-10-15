# Freedom Flooring Room Visualizer — Project Spec
**Last updated:** 2026-10-15 (Phase 4 complete — both services live)  
**Owner:** Seth Blake  
**Purpose:** Step-by-step build guide. Paste this at the start of any session to resume with minimal context overhead.

---

## What This Is

A web-embeddable room visualizer for freedomflooringmi.com. Homeowner uploads a room photo, browses Mohawk flooring products, picks a colorway → AI renders a photorealistic result → lead captured into RevEngine/FLORA.

---

## Tech Stack

| Layer | Choice |
|---|---|
| AI rendering | OpenAI gpt-image-1 via `/v1/images/edits` |
| Backend | Python FastAPI on Railway |
| Frontend | React (Vite) + Tailwind CSS |
| Hosting | Railway (both services) |
| Product catalog | `visualizer-assets/master_catalog.json` (static JSON) |
| Lead capture | RevEngine / FLORA backend |
| Embed | iframe on freedomflooringmi.com |

---

## Key File Locations

```
/root/.openclaw/workspace/
├── visualize.py                         # CLI: room photo + SKU → gpt-image-1 → PNG (DONE ✅)
├── ingest.py                            # PDF → catalog pipeline (DONE ✅)
├── visualizer-assets/
│   ├── master_catalog.json              # 5 WEK60 Madera Trace colorways (DONE ✅)
│   ├── WEK60/                           # Texture PNGs (5 files, DONE ✅)
│   └── results/                         # Test renders land here
└── projects/
    └── floor-scan-web/                  # Scaffold only — to be replaced by new project
        ├── backend/                     # Empty — FastAPI goes here
        └── frontend/                   # Empty — React widget goes here

OpenAI API key: /root/.openclaw/.openai-api-key
```

---

## master_catalog.json Structure (reference)

```json
{
  "products": [{
    "product_line": "Madera Trace",
    "line_code": "WEK60",
    "colorways": [
      { "sku": "32700-127", "color_code": "127", "color_name": "Natural Stone Oak",
        "texture_file": "WEK60-127-natural-stone-oak.png", "texture_px": [544, 515] },
      ...
    ]
  }],
  "sku_index": { "32700-127": { ... } }   // fast lookup by SKU
}
```

---

## Build Plan (Step by Step)

### ✅ Phase 1 — Core Engine (DONE)
- `ingest.py`: PDF sell sheet → catalog.json + master_catalog.json
- `visualize.py`: room photo + SKU → gpt-image-1 → PNG
- `master_catalog.json`: 5 WEK60 colorways seeded
- Test render confirmed working

---

### ✅ Phase 2 — FastAPI Backend

**Location:** `projects/floor-scan-web/backend/`  
**Railway service name:** `ff-visualizer-api`

#### Endpoints to build:

```
GET  /health              → { status: "ok" }
GET  /catalog             → master_catalog.json (full JSON)
POST /visualize           → multipart: room_photo (file) + sku (str)
                            → { result_url: "https://...", sku, color_name }
```

#### `/visualize` logic:
1. Receive `room_photo` file + `sku` string
2. Look up SKU in `master_catalog.json` → get `texture_file` + metadata
3. Load texture from `visualizer-assets/{line_code}/{texture_file}`
4. Call OpenAI gpt-image-1 `/v1/images/edits` (same logic as `visualize.py`)
5. Save result PNG to `visualizer-assets/results/`
6. Return `{ result_url, sku, color_name, product_line }`

#### Key requirements:
- Read API key from `/root/.openclaw/.openai-api-key`
- CORS enabled (allow `freedomflooringmi.com` + `localhost`)
- Max upload size: 10MB
- Timeout: 120s (gpt-image-1 is slow)
- No auth for MVP (add later if needed)

#### Dependencies:
```
fastapi
uvicorn[standard]
python-multipart
httpx  (or use stdlib urllib like visualize.py)
```

#### Railway env vars needed:
```
OPENAI_API_KEY=<from .openai-api-key file>
PORT=8000
```

---

### ✅ Phase 3 — React Frontend Widget

**Location:** `projects/floor-scan-web/frontend/`  
**Stack:** Vite + React + Tailwind  
**Railway service name:** `ff-visualizer-web`

#### 5 screens (single-page flow, no routing needed):

**Screen 1 — Upload**
- Drag-and-drop or tap-to-upload room photo
- Preview thumbnail
- "Next: Choose your floor" CTA

**Screen 2 — Catalog Browse**
- Product line header ("Madera Trace — Engineered White Oak")
- Colorway chips: swatch image + color name
- Tap to select
- "Visualize this floor" CTA

**Screen 3 — Processing**
- Animated spinner
- "Applying your floor... this takes about 20 seconds"
- Calls `POST /visualize` with room photo + selected SKU

**Screen 4 — Result**
- Before/After toggle (original photo ↔ rendered result)
- Color name + product line label
- "Try another color" (back to Screen 2, same photo)
- "I love this — get a quote" CTA → Screen 5

**Screen 5 — Lead Capture**
- Name, email, phone (phone optional)
- "Which product interests you?" (pre-filled from selection)
- "Send me more info" button → POST to RevEngine/FLORA or simple email
- Confirmation message

#### Key requirements:
- Mobile-first, responsive
- Freedom Flooring brand colors (warm neutral / charcoal / amber CTA)
- No login, no auth
- Backend URL configurable via `VITE_API_URL` env var
- Embeddable as iframe (no fixed height, use `window.parent.postMessage` for height updates)

---

### ✅ Phase 4 — Railway Deploy (DONE 2026-10-15)

**Live URLs:**
- Backend API: `https://ff-visualizer-production.up.railway.app`
- Frontend app: `https://ff-visualizer-web-production.up.railway.app`

**Railway projects:**
- Backend: project `ff-visualizer` (ID: `3f1c69bb-b2b2-4a69-b5bd-c30eb8157bf9`), service ID: `7df75800-0c3d-4da8-b702-6401522e95e4`
- Frontend: project `ff-visualizer-web` (ID: `ff042366-da5b-43c4-ad8d-cad1b44cec43`), service ID: `9fe9daa6-68b6-4e59-85e5-122a3bde627b`
- Auth: seth@prospectrdigital.com (OAuth via browser, stored in `~/.railway/config.json`)

**Deploy notes:**
- Backend uses Dockerfile; assets (`visualizer-assets/`) must be staged into `backend/` before `railway up` (already there, covered by .gitignore)
- Frontend uses nixpacks; `VITE_API_URL` is baked in via `frontend/.env.production`
- To redeploy backend: `cd backend && railway up --detach` (assets already staged)
- To redeploy frontend: `cd frontend && railway up --detach`

**Smoke test + integration results (2026-10-15):**
- `GET /health` → `{"status": "ok"}` ✅
- `GET /catalog` → 1 product, 5 colorways, 5 SKU index entries ✅
- Frontend HTTP 200, title correct ✅
- `POST /contact` → GHL contact created (source: Room Visualizer, tag: room-visualizer) + note with rendered image URL ✅
- Dedup: existing contacts get note attached, no lead dropped ✅

**RevEngine wiring (added 2026-10-15):**
- `GHL_PIT` set as Railway env var on backend (source: `/root/.openclaw/.ghl-freedom-flooring.json`)
- `ghl_push_lead()` in `backend/main.py`: creates GHL contact, attaches note with product + visualization URL
- `LeadCaptureScreen.jsx` sends `result_url` in FormData so it travels to backend and into the GHL note
- Dedup fix: GHL 400 "no duplicate contacts" → extracts existing `contactId` from `meta` → adds note
- Verified live: contact `dqn59aIOBhqu58qTvTSK` in RevEngine 2026-10-15
- Commits: `f28fe6e` (GHL wiring) + `2ccf9af` (dedup fix)

---

### 🔧 Phase 5 — Embed on freedomflooringmi.com

**iframe snippet (drop into any page):**
```html
<iframe
  src="https://ff-visualizer-web-production.up.railway.app"
  width="100%"
  height="700"
  frameborder="0"
  style="border-radius: 12px;"
  title="Room Visualizer"
></iframe>
```

**Recommended placement:**
- New page: `/visualizer` (or `/see-it-in-your-home`)
- Link from nav + product pages + hero CTA

---

## Lead Capture Options (Phase 3 Screen 5)

**Option A — Simple email (fastest MVP):**  
POST to a Railway endpoint that sends an email via SMTP or Mailgun.

**Option B — RevEngine/FLORA:**  
POST contact to GHL RevEngine via PIT. Location ID: `z6JTGPFeJiDsu693gpHG` (Freedom Flooring & Design).  
Skill reference: `~/.openclaw/workspace/skills/freedom-flooring-revengine-pit/SKILL.md`

**Recommended:** Start with Option A, wire Option B after the visualizer is working.

---

## Session Startup Prompt (copy-paste to resume)

```
I'm working on the Freedom Flooring room visualizer. Read VISUALIZER_PROJECT_SPEC.md 
in my workspace for full context. We are on Phase [X]. Today's goal: [describe next step].
```

---

## Current Status

| Phase | Status | Notes |
|---|---|---|
| Phase 1 — Core engine | ✅ Done | visualize.py + ingest.py + catalog |
| Phase 2 — FastAPI backend | ✅ Done | /health, /catalog, /visualize, /contact + static file serving |
| Phase 3 — React frontend | ✅ Done | 5 screens, Vite build clean, Freedom Flooring brand |
| Phase 4 — Railway deploy | ✅ Done | Backend + frontend live; RevEngine wiring live |
| Phase 5 — Site embed | 🔧 Next | iframe on freedomflooringmi.com — snippet ready |

---

## Open Questions / Decisions Needed

1. **Lead capture** — Option A (email) or Option B (RevEngine) for MVP?
2. **More product lines** — send additional sell sheet PDFs to run through `ingest.py` before launch
3. **Mohawk dealer assets** — Nolan's rep may have higher-res texture images (preferred over PDF extraction)
4. **Site page name** — `/visualizer` or `/see-it-in-your-home`?
5. **Before/After UX** — toggle or side-by-side? (toggle recommended for mobile)

---

## Notes / Lessons Learned

- gpt-image-1 takes 15–30s per render — show a spinner, set a 120s timeout
- Texture images from sell sheets are ~544×515px swatch photos, NOT seamless tiles — works fine for gpt-image-1 input
- OpenAI returns `b64_json` (not a URL) — decode and save locally, then serve from backend
- PDF text extraction strips embedded images — use `pdfimages -png` + `pdftotext` via `ingest.py`
- Room photo goes first in the `image[]` array, texture second — order matters for gpt-image-1
