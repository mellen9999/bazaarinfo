"""
main.py — Bazaar Card Companion App

Captures the game window at ~2-3 fps, identifies visible cards via SIFT/FLANN,
and POSTs state changes to the EBS for the Twitch overlay extension.

Usage:
    python main.py [--config config.ini] [--debug]

Setup:
    1. pip install -r requirements.txt
    2. python features/extract.py --images /path/to/card/images
    3. Edit config.ini with your EBS URL and channel ID
    4. python main.py
"""

import argparse
import configparser
import logging
import time
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np

from capture import capture_frame
from matcher import CardMatcher, CardMatch
from sender import send_detection

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Card region detection
# ---------------------------------------------------------------------------

def detect_card_regions(frame: np.ndarray) -> list:
    """
    Find candidate card bounding boxes in the frame using simple heuristics:
    - Convert to HSV, look for the distinctive card border color
    - Find contours of the right aspect ratio (~0.6–0.8 for portrait cards)
    - Return regions as list of dicts with x, y, w, h

    This is a lightweight heuristic pass before running the more expensive
    SIFT matching. Tune the HSV thresholds for your game version.
    """
    h_frame, w_frame = frame.shape[:2]

    # Convert to HSV for color-based detection
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)

    # Card borders in The Bazaar tend to have a warm golden hue at various tiers.
    # These are starting-point thresholds — adjust if detection is poor.
    lower = np.array([15, 80, 80], dtype=np.uint8)   # HSV lower
    upper = np.array([35, 255, 255], dtype=np.uint8)  # HSV upper
    mask = cv2.inRange(hsv, lower, upper)

    # Dilate to connect nearby border fragments
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask = cv2.dilate(mask, kernel, iterations=2)

    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    regions = []
    for cnt in contours:
        x, y, w, h = cv2.boundingRect(cnt)

        # Filter by aspect ratio (portrait cards ~0.65) and minimum size
        if h == 0:
            continue
        aspect = w / h
        area = w * h
        min_area = (w_frame * h_frame) * 0.005  # at least 0.5% of screen

        if 0.5 < aspect < 0.9 and area > min_area:
            # Expand bounding box slightly to capture full card
            pad = 5
            x = max(0, x - pad)
            y = max(0, y - pad)
            w = min(w_frame - x, w + pad * 2)
            h = min(h_frame - y, h + pad * 2)
            regions.append({"x": x, "y": y, "w": w, "h": h})

    return regions


# ---------------------------------------------------------------------------
# State change detection
# ---------------------------------------------------------------------------

def cards_changed(prev: list, curr: list) -> bool:
    """
    Return True if the detected card set changed since the last frame.
    Compares by card title set.
    """
    prev_titles = {c.title for c in prev}
    curr_titles = {c.title for c in curr}
    return prev_titles != curr_titles


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run(config: configparser.ConfigParser, debug: bool = False):
    ebs_url = config["ebs"]["url"]
    channel_id = config["ebs"]["channel_id"]
    secret = config["ebs"]["secret"]
    fps = float(config["capture"].get("fps", 2))
    window_title = config["capture"].get("window_title", "The Bazaar")
    ratio_threshold = float(config["matcher"].get("ratio_threshold", 0.7))
    min_good_matches = int(config["matcher"].get("min_good_matches", 15))

    frame_interval = 1.0 / fps

    logger.info("Loading card features...")
    matcher = CardMatcher(
        ratio_threshold=ratio_threshold,
        min_good_matches=min_good_matches,
    )
    logger.info("Ready. Capturing at %.1f fps (window: '%s')", fps, window_title)

    prev_cards: list[CardMatch] = []

    while True:
        loop_start = time.monotonic()

        try:
            # 1. Capture frame
            frame = capture_frame(window_title)

            # 2. Find candidate card regions
            regions = detect_card_regions(frame)

            if debug:
                logger.debug("Detected %d candidate regions", len(regions))

            # 3. Run SIFT matching on each region
            cards = matcher.match_cards(frame, regions)

            if debug and cards:
                logger.debug("Matched: %s", [c.title for c in cards])

            # 4. Only POST if something changed
            if cards_changed(prev_cards, cards):
                logger.info(
                    "Board changed: %s",
                    [c.title for c in cards] if cards else "(empty)",
                )
                success = send_detection(ebs_url, channel_id, secret, cards)
                if success:
                    prev_cards = cards
                else:
                    logger.warning("Send failed — will retry next frame")

        except KeyboardInterrupt:
            logger.info("Stopped by user.")
            break
        except Exception as e:
            logger.error("Frame error: %s", e, exc_info=debug)

        # Sleep to maintain target fps
        elapsed = time.monotonic() - loop_start
        sleep_time = max(0.0, frame_interval - elapsed)
        time.sleep(sleep_time)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Bazaar Card Companion App")
    parser.add_argument(
        "--config",
        type=Path,
        default=Path(__file__).parent / "config.ini",
        help="Path to config.ini (default: config.ini next to main.py)",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Enable verbose debug logging",
    )
    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    config = configparser.ConfigParser()
    if not args.config.exists():
        print(f"Config not found: {args.config}")
        print("Copy config.ini.example to config.ini and fill in your details.")
        raise SystemExit(1)

    config.read(args.config)

    # Basic config validation
    for required in [("ebs", "url"), ("ebs", "channel_id"), ("ebs", "secret")]:
        section, key = required
        val = config.get(section, key, fallback="")
        if not val or val.startswith("YOUR_"):
            print(f"[config] Please set [{section}] {key} in {args.config}")
            raise SystemExit(1)

    run(config, debug=args.debug)


if __name__ == "__main__":
    main()
