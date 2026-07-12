# Zeus 3.0 — Home-Service Automation Pipeline

A reference implementation of the **Zeus 3.0** multi-agent pipeline for
residential home-service businesses. It manages the customer lifecycle from
lead ingestion through AI routing, objection handling, review/referral
routing, and seasonal nurturing.

## Architecture

```
[ Lead Ingestion ] ─────────────────┐
(Web / LSA / Yelp / Meta / Angi)     │
                                     ▼
[ Rehash Database ] ─► [ AI Routing Engine ] ─► [ Calendar Booking ]
(Past / cold leads)   (Text, Email, Voice)      (Confirm & Reschedule)
                                     │
                                     ▼
[ Post-Job Pipeline ] ◄── [ Disposition Funnel ]
(Seasonal Nurturing)      (Objection Handling)
         │
         ▼
[ Review & Referral Engine ] ─► [ Star Rating Routing ]
                                ├── 1-3 stars: internal escalation
                                └── 4-5 stars: Google review + referral
```

## Endpoints

| Method | Path                         | Purpose                                        |
| ------ | ---------------------------- | ---------------------------------------------- |
| POST   | `/webhook/lead_ingestion`    | Ingest a new lead and fire initial AI outreach |
| POST   | `/lead/update_disposition`   | Update lead state and pick objection strategy  |
| POST   | `/feedback/review_funnel`    | Route feedback by star rating                  |
| GET    | `/cron/seasonal_nurture`     | Batch seasonal check-ins for older accounts    |
| GET    | `/health`                    | Health check                                   |

## AI agents

Three single-responsibility LLM wrappers (see `agents.py`):

- **text** — SMS coordinator (replies under 160 chars, prompts for a booking window)
- **email** — polished follow-up drafts
- **receptionist** — AI voice receptionist offering calendar availability

If `OPENAI_API_KEY` is not set (or the SDK/API is unavailable), the agents
fall back to deterministic templated replies, so the pipeline runs offline
and in CI without any external calls.

## Setup

```bash
cd zeus-pipeline
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill in OPENAI_API_KEY if you want live LLM replies
python automation_pipeline.py
```

The server listens on `http://127.0.0.1:5000` by default (override with `PORT`).

## Try it

```bash
# 1. Ingest a lead
curl -X POST http://127.0.0.1:5000/webhook/lead_ingestion \
  -H "Content-Type: application/json" \
  -d '{"name":"John Doe","email":"john@example.com","phone":"555-0199","source":"Angi"}'

# 2. Route an objection
curl -X POST http://127.0.0.1:5000/lead/update_disposition \
  -H "Content-Type: application/json" \
  -d '{"lead_id":"555-0199","disposition":"Needs to talk to spouse"}'

# 3. Submit 5-star feedback
curl -X POST http://127.0.0.1:5000/feedback/review_funnel \
  -H "Content-Type: application/json" \
  -d '{"lead_id":"555-0199","rating":5}'

# 4. Fire a seasonal nurture batch
curl "http://127.0.0.1:5000/cron/seasonal_nurture?season=Winter"
```

## Tests

```bash
cd zeus-pipeline
pip install pytest
python -m pytest
```

Tests run fully offline (no API key required).

## Notes / productionizing

- `LEAD_DATABASE` is an in-memory dict for demo purposes. Swap it for a real
  datastore (Postgres, Redis) or CRM API before production use.
- Add auth (a shared secret / signature check) to the webhook endpoints.
- The lead id is the caller's phone number reduced to digits — replace with a
  real primary key if you expect number collisions or international formats.
