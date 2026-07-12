"""AI agent wrappers for the Zeus 3.0 home-service pipeline.

Each "agent" is a thin, single-responsibility wrapper around an LLM call:

  - text         -> SMS coordinator (short, prompts for a booking window)
  - email        -> polished follow-up drafts
  - receptionist -> AI voice receptionist handling inbound inquiries

If ``OPENAI_API_KEY`` is not configured (or the SDK isn't installed, or the
call fails) every agent degrades gracefully to a deterministic templated
reply so the pipeline stays runnable offline and in tests.
"""

import json
import os

# The OpenAI SDK is optional at import time. The pipeline must still boot and
# serve templated fallbacks when it (or an API key) is unavailable.
try:  # pragma: no cover - import shim
    from openai import OpenAI
except Exception:  # pragma: no cover
    OpenAI = None


SYSTEM_PROMPTS = {
    "text": (
        "You are an expert SMS coordinator for a home service company. "
        "Keep replies under 160 characters. Be helpful and prompt for a "
        "booking window."
    ),
    "email": (
        "You are a professional email assistant. Draft polished, concise "
        "follow-ups focused on solving the customer's repair problems."
    ),
    "receptionist": (
        "You are an AI voice receptionist. Handle incoming inquiries "
        "gracefully and offer calendar availability."
    ),
}

MODEL = os.environ.get("ZEUS_MODEL", "gpt-4o-mini")

# Module-level client, created lazily so importing this module never fails.
_client = None


def _get_client():
    """Return a cached OpenAI client, or ``None`` if unavailable."""
    global _client
    if _client is not None:
        return _client
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key or OpenAI is None:
        return None
    _client = OpenAI(api_key=api_key)
    return _client


def _fallback_reply(agent_type, lead_data):
    """Deterministic, network-free reply used when the LLM is unavailable."""
    name = (lead_data or {}).get("name") or "there"
    if agent_type == "email":
        return (
            f"Hi {name},\n\nThanks for reaching out about your project. "
            "We'd love to help get it sorted quickly. Reply with a day and "
            "time that works and we'll lock in your appointment.\n\n"
            "— The FXR Team"
        )
    if agent_type == "receptionist":
        return (
            f"Thanks for calling, {name}! I can check our calendar and find "
            "the next available slot. What day works best for you?"
        )
    # Default: text / SMS agent (kept under 160 chars).
    return (
        f"Hi {name}! Thanks for contacting us. What day/time works for a "
        "visit? Reply here and we'll get you booked."
    )


def run_ai_agent(agent_type, lead_data, last_message=""):
    """Generate the next response for the given agent.

    Falls back to a templated reply if the LLM call cannot be made.
    """
    client = _get_client()
    if client is None:
        return _fallback_reply(agent_type, lead_data)

    system_prompt = SYSTEM_PROMPTS.get(agent_type, "You are a helpful assistant.")
    prompt = (
        f"Lead Context: {json.dumps(lead_data)}\n"
        f"Last Interaction: {last_message}\n"
        "Generate the next response:"
    )

    try:
        response = client.chat.completions.create(
            model=MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ],
            max_tokens=200,
        )
        return response.choices[0].message.content.strip()
    except Exception:
        # Never let an upstream outage break the pipeline.
        return _fallback_reply(agent_type, lead_data)
