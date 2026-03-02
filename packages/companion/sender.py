"""
sender.py — HTTP POST detected cards to the EBS /detect endpoint

Rate-limited to 1 send per 2 seconds minimum to avoid flooding the EBS.
"""

import time
import logging
import requests
from dataclasses import asdict

logger = logging.getLogger(__name__)

_last_send_time: float = 0.0
MIN_SEND_INTERVAL = 2.0  # seconds


def send_detection(
    ebs_url: str,
    channel_id: str,
    secret: str,
    cards: list,
) -> bool:
    """
    POST detected cards to the EBS /detect endpoint.

    Args:
        ebs_url:    Base URL of the EBS, e.g. https://bazaar-ebs.example.com
        channel_id: Twitch channel ID (numeric string)
        secret:     Shared companion secret for the EBS
        cards:      List of CardMatch dataclass instances

    Returns:
        True if the POST succeeded, False on error
    """
    global _last_send_time

    # Enforce minimum send interval
    elapsed = time.monotonic() - _last_send_time
    if elapsed < MIN_SEND_INTERVAL:
        time.sleep(MIN_SEND_INTERVAL - elapsed)

    # Serialize cards — convert dataclasses to plain dicts
    cards_payload = []
    for card in cards:
        cards_payload.append(asdict(card) if hasattr(card, "__dataclass_fields__") else card)

    payload = {
        "channelId": channel_id,
        "secret": secret,
        "cards": cards_payload,
    }

    url = ebs_url.rstrip("/") + "/detect"

    try:
        response = requests.post(url, json=payload, timeout=5)
        response.raise_for_status()
        _last_send_time = time.monotonic()
        logger.debug(f"[sender] Posted {len(cards)} cards -> {response.status_code}")
        return True

    except requests.exceptions.ConnectionError:
        logger.warning(f"[sender] Connection failed: {url} (is the EBS running?)")
    except requests.exceptions.Timeout:
        logger.warning(f"[sender] Request timed out: {url}")
    except requests.exceptions.HTTPError as e:
        logger.warning(f"[sender] HTTP error: {e}")
    except Exception as e:
        logger.warning(f"[sender] Unexpected error: {e}")

    _last_send_time = time.monotonic()
    return False
