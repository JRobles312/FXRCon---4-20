"""Zeus 3.0 — home-service automation pipeline (reference implementation).

A Flask app that models the core Zeus 3.0 architecture:

    Lead Ingestion  ->  AI Routing (Text / Email / Receptionist)
          |
          v
    Disposition / Objection Funnel  ->  Nurture sequences
          |
          v
    Review & Referral Engine  ->  Star-rating routing
                                   |-- 1-3 stars: internal escalation
                                   |-- 4-5 stars: Google review + referral

Leads are held in an in-memory store for demo purposes. Swap
``LEAD_DATABASE`` for a real datastore (Postgres, Redis, CRM API) in
production.
"""

import os
import re

from flask import Flask, jsonify, request

from agents import run_ai_agent

app = Flask(__name__)

# Simulated in-memory database for leads. Keyed by normalized phone number.
LEAD_DATABASE = {}

# Customer-facing links / offers, configurable via environment.
GOOGLE_REVIEW_LINK = os.environ.get(
    "ZEUS_GOOGLE_REVIEW_LINK", "https://g.page/r/your-review-link"
)
REFERRAL_REWARD = os.environ.get("ZEUS_REFERRAL_REWARD", "$50")

VALID_SEASONS = {"Winter", "Spring", "Summer", "Fall"}


def normalize_phone(phone):
    """Reduce a phone number to its digits so it can act as a stable key."""
    if not phone:
        return ""
    return re.sub(r"\D", "", str(phone))


# ---------------------------------------------------------------------------
# 1. Ingestion / webhook endpoint
# ---------------------------------------------------------------------------
@app.route("/webhook/lead_ingestion", methods=["POST"])
def lead_ingestion():
    """Handle inbound leads from Web forms, Thumbtack, Angi, Yelp, LSA, Meta."""
    data = request.get_json(silent=True) or {}
    source = data.get("source", "Unknown Website")
    email = data.get("email")
    phone = data.get("phone")
    name = data.get("name")

    if not email or not phone:
        return (
            jsonify({"status": "error", "message": "Missing vital contact info"}),
            400,
        )

    lead_id = normalize_phone(phone)

    LEAD_DATABASE[lead_id] = {
        "name": name,
        "email": email,
        "phone": phone,
        "source": source,
        "status": "New Lead",
        "disposition": "Needs Help",
        "history": [],
    }

    # Trigger initial AI outreach for the new lead.
    outreach_msg = run_ai_agent(
        "text", LEAD_DATABASE[lead_id], "Initial system ingestion trigger"
    )
    LEAD_DATABASE[lead_id]["history"].append(
        {"agent": "system_outreach", "message": outreach_msg}
    )

    return (
        jsonify(
            {
                "status": "success",
                "lead_id": lead_id,
                "outreach_dispatched": outreach_msg,
            }
        ),
        200,
    )


# ---------------------------------------------------------------------------
# 2. Disposition & objection-handling funnel
# ---------------------------------------------------------------------------
OBJECTION_STRATEGIES = {
    "Needs to talk to spouse": (
        "Send a co-decision-maker summary sheet via email.",
        "Nurturing - Spouse Review",
    ),
    "Cant afford": (
        "Trigger financing options and tiered-discount alternatives.",
        "Nurturing - Price Objection",
    ),
    "Not interested": (
        "Move to a low-frequency monthly nurture sequence.",
        "Archived Nurture",
    ),
}


@app.route("/lead/update_disposition", methods=["POST"])
def update_disposition():
    """Update lead categorization and pick the matching objection strategy."""
    data = request.get_json(silent=True) or {}
    lead_id = normalize_phone(data.get("lead_id"))
    new_disposition = data.get("disposition")

    if lead_id not in LEAD_DATABASE:
        return jsonify({"status": "error", "message": "Lead not found"}), 404

    lead = LEAD_DATABASE[lead_id]
    lead["disposition"] = new_disposition

    strategy, status = OBJECTION_STRATEGIES.get(
        new_disposition,
        ("Standard booking pipeline sequence maintenance.", lead["status"]),
    )
    lead["status"] = status

    return (
        jsonify(
            {
                "status": "updated",
                "lead_id": lead_id,
                "current_status": lead["status"],
                "next_automated_action": strategy,
            }
        ),
        200,
    )


# ---------------------------------------------------------------------------
# 3. Review & gift-card referral funnel
# ---------------------------------------------------------------------------
@app.route("/feedback/review_funnel", methods=["POST"])
def review_funnel():
    """Route feedback by star rating.

    1-3 stars are held internally for dispute resolution; 4-5 stars are
    pushed out to Google reviews and the referral program.
    """
    data = request.get_json(silent=True) or {}
    lead_id = normalize_phone(data.get("lead_id"))

    try:
        rating = int(data.get("rating"))
    except (TypeError, ValueError):
        return jsonify({"status": "error", "message": "Invalid rating value"}), 400

    if lead_id not in LEAD_DATABASE:
        return jsonify({"status": "error", "message": "Lead record mismatch"}), 404

    lead = LEAD_DATABASE[lead_id]

    if rating in (1, 2, 3):
        action = (
            f"Alert branch manager to contact {lead['name']} immediately "
            "for dispute resolution."
        )
        response_text = (
            "We are truly sorry to hear about your experience. A manager "
            "will call you shortly."
        )
    elif rating in (4, 5):
        action = "Send Google review link + generate unique referral link."
        response_text = (
            f"Thank you so much! Leave us a review here: {GOOGLE_REVIEW_LINK} "
            f"— and check your texts for a {REFERRAL_REWARD} friend-referral pass!"
        )
    else:
        return (
            jsonify({"status": "error", "message": "Rating must be 1-5"}),
            400,
        )

    return (
        jsonify(
            {
                "status": "processed",
                "rating_received": rating,
                "action_taken": action,
                "customer_facing_response": response_text,
            }
        ),
        200,
    )


# ---------------------------------------------------------------------------
# 4. Seasonal system check-ins & maintenance
# ---------------------------------------------------------------------------
@app.route("/cron/seasonal_nurture", methods=["GET"])
def seasonal_nurture():
    """Batch check-ins for older / archived accounts by season."""
    season = request.args.get("season", "Spring")
    if season not in VALID_SEASONS:
        return (
            jsonify(
                {
                    "status": "error",
                    "message": f"season must be one of {sorted(VALID_SEASONS)}",
                }
            ),
            400,
        )

    targeted_leads = []
    for lead_id, lead in LEAD_DATABASE.items():
        if lead["status"] in ("New Lead", "Archived Nurture"):
            message = (
                f"Hey {lead['name']}, it's time for a {season} system tune-up. "
                "Ready for an inspection?"
            )
            targeted_leads.append({"phone": lead_id, "dispatched_msg": message})

    return (
        jsonify(
            {
                "status": "executed",
                "season": season,
                "total_notified": len(targeted_leads),
                "list": targeted_leads,
            }
        ),
        200,
    )


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------
@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "leads_tracked": len(LEAD_DATABASE)}), 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
