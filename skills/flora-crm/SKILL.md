<!-- CANONICAL: github.com/Prospectr/chief-of-staff  skills/flora-crm/SKILL.md -->

# FLORA CRM Skill

## Changelog

### 2026-10-14
- **Room visualizer** (Seth Blake / Freedom Flooring) — commit ebf870f:
  - `ingest.py`: Mohawk PDF → master_catalog.json pipeline
  - `visualize.py`: room photo + SKU → gpt-image-1 composite (OpenAI Images Edits API)
  - `master_catalog.json`: seeded with WEK60/Madera Trace (5 colorways)
  - Next: FastAPI service on Railway wrapping /ingest and /visualize endpoints
