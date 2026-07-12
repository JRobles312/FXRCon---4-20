"""Tests for the Zeus 3.0 pipeline.

These run fully offline: with no OPENAI_API_KEY set, the AI agents return
deterministic templated replies, so no network calls are made.
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import automation_pipeline as pipeline  # noqa: E402


@pytest.fixture
def client():
    pipeline.app.config["TESTING"] = True
    pipeline.LEAD_DATABASE.clear()
    with pipeline.app.test_client() as c:
        yield c


def _ingest(client, phone="555-0199", name="John Doe"):
    return client.post(
        "/webhook/lead_ingestion",
        json={"name": name, "email": "john@example.com", "phone": phone, "source": "Angi"},
    )


def test_ingestion_creates_lead(client):
    resp = _ingest(client)
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["status"] == "success"
    # Phone is normalized to digits and used as the lead id.
    assert body["lead_id"] == "5550199"
    assert body["outreach_dispatched"]
    assert "5550199" in pipeline.LEAD_DATABASE


def test_ingestion_requires_contact_info(client):
    resp = client.post("/webhook/lead_ingestion", json={"name": "No Contact"})
    assert resp.status_code == 400


def test_disposition_price_objection(client):
    _ingest(client)
    resp = client.post(
        "/lead/update_disposition",
        json={"lead_id": "555-0199", "disposition": "Cant afford"},
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["current_status"] == "Nurturing - Price Objection"
    assert "financing" in body["next_automated_action"].lower()


def test_disposition_unknown_lead(client):
    resp = client.post(
        "/lead/update_disposition",
        json={"lead_id": "000-0000", "disposition": "Not interested"},
    )
    assert resp.status_code == 404


def test_review_low_rating_escalates(client):
    _ingest(client)
    resp = client.post(
        "/feedback/review_funnel", json={"lead_id": "555-0199", "rating": 2}
    )
    body = resp.get_json()
    assert resp.status_code == 200
    assert "manager" in body["action_taken"].lower()


def test_review_high_rating_routes_out(client):
    _ingest(client)
    resp = client.post(
        "/feedback/review_funnel", json={"lead_id": "555-0199", "rating": 5}
    )
    body = resp.get_json()
    assert resp.status_code == 200
    assert "review" in body["action_taken"].lower()
    assert "referral" in body["action_taken"].lower()


def test_review_invalid_rating(client):
    _ingest(client)
    resp = client.post(
        "/feedback/review_funnel", json={"lead_id": "555-0199", "rating": 9}
    )
    assert resp.status_code == 400


def test_review_non_numeric_rating(client):
    _ingest(client)
    resp = client.post(
        "/feedback/review_funnel", json={"lead_id": "555-0199", "rating": "great"}
    )
    assert resp.status_code == 400


def test_seasonal_nurture_targets_new_and_archived(client):
    _ingest(client, phone="555-0001", name="Alice")
    resp = client.get("/cron/seasonal_nurture?season=Winter")
    body = resp.get_json()
    assert resp.status_code == 200
    assert body["season"] == "Winter"
    assert body["total_notified"] == 1


def test_seasonal_nurture_rejects_bad_season(client):
    resp = client.get("/cron/seasonal_nurture?season=Monsoon")
    assert resp.status_code == 400


def test_health(client):
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.get_json()["status"] == "ok"
