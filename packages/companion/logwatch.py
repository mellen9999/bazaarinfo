"""
logwatch.py — Watch The Bazaar's Player.log for board state changes

Tails the Unity Player.log, extracts card events, maps template IDs to
card names, tracks player/opponent boards + skills + shop, and POSTs
overlay positions to the EBS.

Replaces BepInEx plugin — no game memory hooks, TOS-safe.

Usage:
    python logwatch.py [--config config.ini] [--debug]
"""

import argparse
import configparser
import json
import logging
import os
import re
import time
from pathlib import Path

import requests

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# Player.log path inside Proton prefix
DEFAULT_LOG = (
    Path.home()
    / ".local/share/Steam/steamapps/compatdata/1617400/pfx/drive_c"
    / "users/steamuser/AppData/LocalLow/Tempo Storm/The Bazaar/Player.log"
)

# --- Log parsing patterns ---

RE_CARD_PURCHASED = re.compile(
    r"\[BoardManager\] Card Purchased: InstanceId: (\S+) - "
    r"TemplateId(\S+) - Target:(\S+) - Section(\S+)"
)
RE_CARDS_DISPOSED = re.compile(
    r"\[GameSimHandler\] Cards Disposed: (.+)"
)
RE_CARDS_DEALT = re.compile(
    r"\[GameSimHandler\] Cards Dealt: (.+)"
)
RE_CARDS_SPAWNED = re.compile(
    r"\[GameSimHandler\] Cards Spawned: (.+)"
)
RE_CARD_SOLD = re.compile(
    r"\[BoardManager\] Sold Card (\S+)"
)
RE_SKILL_SELECTED = re.compile(
    r"\[AppState\] Selected skill (\S+) to socket SkillSocket_(\d+)"
)
RE_STATE_CHANGE = re.compile(
    r"\[AppState\] State changed from \[(\w+)\] to \[(\w+)\]"
)
RE_CARD_MOVED_TO = re.compile(
    r"\[CardOperationUtility\] Successfully moved card to: \[(\S+) \[(\w+)\] \[(\w+)\] \[Socket_(\d+)\] \[(\w+)\]"
)
RE_CARD_MOVED_SOCKET = re.compile(
    r"\[CardOperationUtility\] Successfully moved card (\S+) to Socket_(\d+)"
)
RE_CARD_REMOVED = re.compile(
    r"\[CardOperationUtility\] Successfully removed item (\S+) from (\w+)'s inventory"
)

# --- Overlay positions (viewport-normalized, 1920x1080 reference) ---

# Item sockets: 10 slots per side, center-aligned
# Measured from 1920x1080 fullscreen screenshots (ss1fin.png, 2ssfin.png)
ITEM_SOCKET_W = 0.058604   # slot pitch (from BepInEx CoordsLogger)
ITEM_CARD_W = 0.058604     # visible card width = pitch (single slot)
PLAYER_ITEM_H = 0.231916   # player card height (from BepInEx)
OPPONENT_ITEM_H = 0.231916  # opponent card height (from BepInEx)
PLAYER_ITEM_Y = 0.618796   # vertical center (from BepInEx)
OPPONENT_ITEM_Y = 0.397443  # vertical center (from BepInEx)
ITEM_BOARD_CENTER_X = 0.5000  # exact center (from BepInEx)

# Multi-size items occupy multiple slots
SIZE_SLOTS = {"Small": 1, "Medium": 2, "Large": 3}

# Skill visual positions (viewport coords from annotated screenshots)
# Triangle layout (<=5 skills): 3 left of hero, 3 right
SKILL_TRIANGLE_POS = [
    (0.3413, 0.8211),  # pos 0: outer left top
    (0.3794, 0.8867),  # pos 1: outer left bottom
    (0.4182, 0.8229),  # pos 2: inner left
    (0.5839, 0.8251),  # pos 3: inner right
    (0.6183, 0.8847),  # pos 4: outer right bottom
    (0.6572, 0.8209),  # pos 5: outer right top
]

# Grid layout (>=6 skills): 2 rows of 3 per side (12 slots total)
SKILL_GRID_POS = [
    (0.3358, 0.8130),  # grid 0: top-left 1
    (0.3800, 0.8140),  # grid 1: top-left 2
    (0.4245, 0.8142),  # grid 2: top-left 3
    (0.5743, 0.8133),  # grid 3: top-right 1
    (0.6187, 0.8130),  # grid 4: top-right 2
    (0.6624, 0.8128),  # grid 5: top-right 3
    (0.3362, 0.8888),  # grid 6: bot-left 1
    (0.3804, 0.8898),  # grid 7: bot-left 2
    (0.4243, 0.8913),  # grid 8: bot-left 3
    (0.5720, 0.8880),  # grid 9: bot-right 1
    (0.6162, 0.8894),  # grid 10: bot-right 2
    (0.6607, 0.8878),  # grid 11: bot-right 3
]

# Skill icon size (viewport-normalized)
SKILL_W = 0.057
SKILL_H = 0.057
SKILL_GRID_SCALE = 0.7  # grid skills are smaller

# States where overlay should be hidden
HIDDEN_STATES = {"StartRunAppState", "EndRunDefeatAppState", "EndRunVictoryAppState"}
# States where overlay should be shown
GAME_STATES = {"ChoiceState", "EncounterState", "CombatState", "ReplayState"}


def load_card_db(cards_json: Path) -> dict:
    """Load template ID -> card info mapping from game's cards.json."""
    with open(cards_json) as f:
        data = json.load(f)

    cards = data.get("5.0.0", data) if isinstance(data, dict) else data
    db = {}
    for c in cards:
        tid = c.get("Id", "")
        title = c.get("Localization", {}).get("Title", {}).get("Text", "")
        if not title:
            title = c.get("InternalName", tid)
        tier = c.get("StartingTier", "Unknown")
        size = c.get("Size", "Medium")
        card_type = c.get("Type", "Item")
        db[tid] = {"title": title, "tier": tier, "size": size, "type": card_type}

    logger.info("Loaded %d cards from %s", len(db), cards_json)
    return db


def make_item_payload(info: dict, owner: str) -> dict:
    """Build a card payload dict for an item on the board."""
    socket = info.get("socket", 5)
    size = info.get("size", "Medium")
    slots = SIZE_SLOTS.get(size, 2)
    if owner == "player":
        y_center = PLAYER_ITEM_Y
        h = PLAYER_ITEM_H
    else:
        y_center = OPPONENT_ITEM_Y
        h = OPPONENT_ITEM_H
    w = ITEM_CARD_W + (slots - 1) * ITEM_SOCKET_W
    # socket is the leftmost slot. Card center = leftmost slot center + half the extra slots
    slot_center_x = ITEM_BOARD_CENTER_X + (socket - 4.5) * ITEM_SOCKET_W
    card_center_x = slot_center_x + (slots - 1) * ITEM_SOCKET_W / 2
    return {
        "title": info["title"],
        "tier": info["tier"],
        "x": card_center_x - w / 2,
        "y": y_center - h / 2,
        "w": w,
        "h": h,
        "owner": owner,
        "type": "Item",
    }


def make_skill_payload(info: dict, owner: str, total_skills: int) -> dict | None:
    """Build a card payload dict for a skill."""
    socket = info.get("socket", 0)

    if total_skills >= 6:
        # Grid layout
        if socket < 0 or socket >= len(SKILL_GRID_POS):
            return None
        vx, vy = SKILL_GRID_POS[socket]
        sw = SKILL_W * SKILL_GRID_SCALE
        sh = SKILL_H * SKILL_GRID_SCALE
    else:
        # Triangle layout
        if socket < 0 or socket >= len(SKILL_TRIANGLE_POS):
            return None
        vx, vy = SKILL_TRIANGLE_POS[socket]
        sw = SKILL_W
        sh = SKILL_H

    if owner == "opponent":
        vy = 1.0 - vy

    return {
        "title": info["title"],
        "tier": info["tier"],
        "x": vx - sw / 2,
        "y": vy - sh / 2,
        "w": sw,
        "h": sh,
        "owner": owner,
        "type": "Skill",
    }


def build_payload(state: dict) -> dict:
    """Build the full EBS payload from current game state."""
    cards = []

    # Player items
    for info in state["player_board"].values():
        cards.append(make_item_payload(info, "player"))

    # Opponent items
    for info in state["opponent_board"].values():
        cards.append(make_item_payload(info, "opponent"))

    # Player skills
    p_skill_count = len(state["player_skills"])
    for info in state["player_skills"].values():
        p = make_skill_payload(info, "player", p_skill_count)
        if p:
            cards.append(p)

    # Shop
    shop = [
        {"title": s["title"], "type": s["type"], "tier": s["tier"], "size": s["size"]}
        for s in state["shop_cards"]
    ]

    return {"cards": cards, "shop": shop}


def send_state(ebs_url: str, channel_id: str, secret: str, state: dict):
    """POST current game state to EBS."""
    if not state["show_overlay"]:
        # Send empty to clear overlay
        payload = {"cards": [], "shop": []}
    else:
        payload = build_payload(state)

    try:
        r = requests.post(
            f"{ebs_url}/detect",
            json={
                "channelId": channel_id,
                "secret": secret,
                "cards": payload["cards"],
                "shop": payload.get("shop", []),
            },
            timeout=5,
        )
        n = len(payload["cards"])
        ns = len(payload.get("shop", []))
        if r.ok:
            logger.info("Broadcast %d cards, %d shop", n, ns)
        else:
            logger.warning("EBS returned %d: %s", r.status_code, r.text[:200])
    except Exception as e:
        logger.error("Send failed: %s", e)


def new_state() -> dict:
    """Create a fresh game state dict."""
    return {
        "player_board": {},      # instance_id -> {title, tier, size, socket}
        "opponent_board": {},    # instance_id -> {title, tier, size, socket}
        "player_skills": {},     # instance_id -> {title, tier, socket}
        "shop_cards": [],        # [{title, type, tier, size}]
        "instance_map": {},      # instance_id -> template_id
        "next_player_skill": 0,  # sequential skill socket counter
        "show_overlay": False,
    }


def parse_spawned_chunk(chunk: str) -> dict | None:
    """Parse a single chunk from Cards Spawned into structured data.

    Format: [instanceId] [Owner] [Section] [Socket_N] [Size]
    Example: abc123 [Player] [Hand] [Socket_3] [Small]
    """
    chunk = chunk.strip()
    if not chunk:
        return None
    parts = chunk.split()
    if len(parts) < 2:
        return None

    inst_id = parts[0].strip("[]")
    owner = None
    socket_num = None
    size = None
    section = None

    for p in parts[1:]:
        p = p.strip("[]")
        if p in ("Player", "Opponent"):
            owner = p
        elif p == "Hand":
            section = "Hand"
        elif p.startswith("Socket_"):
            try:
                socket_num = int(p.split("_")[1])
            except ValueError:
                pass
        elif p in ("Small", "Medium", "Large"):
            size = p

    return {
        "inst_id": inst_id,
        "owner": owner,
        "section": section,
        "socket": socket_num,
        "size": size,
    }


_LINE_PREFIXES = ("BoardManager", "GameSimHandler", "AppState", "CardOperationUtility")


def process_line(line: str, state: dict, card_db: dict, debug: bool) -> bool:
    """Process a single log line, updating state. Returns True if state changed."""

    # Fast bail-out: skip lines that can't match any pattern
    if not any(p in line for p in _LINE_PREFIXES):
        return False

    # Card purchased (player buys from shop)
    m = RE_CARD_PURCHASED.search(line)
    if m:
        instance_id, template_id, target, section = m.groups()
        state["instance_map"][instance_id] = template_id

        socket_num = 5
        if "_" in target:
            try:
                socket_num = int(target.split("_")[-1])
            except ValueError:
                pass

        if section == "Player":
            info = card_db.get(template_id)
            if info:
                entry = {
                    "title": info["title"],
                    "tier": info["tier"],
                    "size": info["size"],
                    "socket": socket_num,
                }
                state["player_board"][instance_id] = entry
                logger.info("+ %s (%s) -> Socket_%d", info["title"], info["tier"], socket_num)

                # Remove from shop if present
                state["shop_cards"] = [
                    s for s in state["shop_cards"] if s["title"] != info["title"]
                ]
            elif debug:
                logger.debug("Unknown template: %s", template_id)
            return True
        return False

    # Card sold
    m = RE_CARD_SOLD.search(line)
    if m:
        sold_id = m.group(1)
        if sold_id in state["player_board"]:
            logger.info("$ sold %s", state["player_board"][sold_id]["title"])
            del state["player_board"][sold_id]
            return True
        return False

    # Cards disposed
    m = RE_CARDS_DISPOSED.search(line)
    if m:
        changed = False
        for did in (x.strip() for x in m.group(1).split("|") if x.strip()):
            if did in state["player_board"]:
                logger.info("- %s", state["player_board"][did]["title"])
                del state["player_board"][did]
                changed = True
            if did in state["opponent_board"]:
                del state["opponent_board"][did]
                changed = True
        return changed

    # Cards spawned (items re-appear after combat, opponent board, skills)
    m = RE_CARDS_SPAWNED.search(line)
    if m:
        changed = False
        for chunk in m.group(1).split("|"):
            parsed = parse_spawned_chunk(chunk)
            if not parsed:
                continue

            inst_id = parsed["inst_id"]
            tid = state["instance_map"].get(inst_id)
            info = card_db.get(tid) if tid else None

            # Skills: have owner but no section/socket (e.g. [skl_xxx [Player] [Medium])
            is_skill = inst_id.startswith("skl_")
            if is_skill and parsed["owner"] == "Player":
                if inst_id not in state["player_skills"]:
                    title = info["title"] if info else inst_id
                    tier = info["tier"] if info else "Unknown"
                    # Check if already tracked by name
                    already = any(
                        s["title"] == title
                        for s in state["player_skills"].values()
                    )
                    if not already:
                        socket_idx = state["next_player_skill"]
                        state["next_player_skill"] = socket_idx + 1
                        if socket_idx < 12:
                            state["player_skills"][inst_id] = {
                                "title": title,
                                "tier": tier,
                                "socket": socket_idx,
                            }
                            logger.info("* skill %s -> slot %d", title, socket_idx)
                            changed = True
                continue

            # Items need a socket to be placed on the board
            if parsed["socket"] is None:
                continue

            # Skip stash items
            if parsed["section"] != "Hand":
                continue

            title = info["title"] if info else inst_id
            tier = info["tier"] if info else "Unknown"
            size = parsed["size"] or (info["size"] if info else "Medium")

            if parsed["owner"] == "Player":
                state["player_board"][inst_id] = {
                    "title": title,
                    "tier": tier,
                    "size": size,
                    "socket": parsed["socket"],
                }
                if debug:
                    logger.debug("~ spawn %s -> Socket_%d", title, parsed["socket"])
                changed = True

            elif parsed["owner"] == "Opponent":
                state["opponent_board"][inst_id] = {
                    "title": title,
                    "tier": tier,
                    "size": size,
                    "socket": parsed["socket"],
                }
                changed = True

        return changed

    # Card moved to (full placement with owner/section/socket/size)
    m = RE_CARD_MOVED_TO.search(line)
    if m:
        inst_id, owner, section, socket_str, size = m.groups()
        socket_num = int(socket_str)
        if section == "Hand":
            tid = state["instance_map"].get(inst_id)
            info = card_db.get(tid) if tid else None
            board = state["player_board"] if owner == "Player" else state["opponent_board"]
            if inst_id in board:
                board[inst_id]["socket"] = socket_num
                if size in ("Small", "Medium", "Large"):
                    board[inst_id]["size"] = size
            elif info:
                board[inst_id] = {
                    "title": info["title"],
                    "tier": info["tier"],
                    "size": size if size in ("Small", "Medium", "Large") else info["size"],
                    "socket": socket_num,
                }
                if debug:
                    logger.debug("+ moved_to %s -> Socket_%d (%s)", info["title"], socket_num, owner)
            return True
        return False

    # Card moved to different socket (no owner/section info — assume player)
    m = RE_CARD_MOVED_SOCKET.search(line)
    if m:
        inst_id = m.group(1)
        socket_num = int(m.group(2))
        if inst_id in state["player_board"]:
            state["player_board"][inst_id]["socket"] = socket_num
            return True
        if inst_id in state["opponent_board"]:
            state["opponent_board"][inst_id]["socket"] = socket_num
            return True
        return False

    # Card removed from inventory
    m = RE_CARD_REMOVED.search(line)
    if m:
        inst_id = m.group(1)
        owner = m.group(2)
        if owner.lower() == "player" and inst_id in state["player_board"]:
            logger.info("- removed %s", state["player_board"][inst_id]["title"])
            del state["player_board"][inst_id]
            return True
        return False

    # Skill selected (from skill choice screen)
    m = RE_SKILL_SELECTED.search(line)
    if m:
        inst_id = m.group(1)
        tid = state["instance_map"].get(inst_id)
        info = card_db.get(tid) if tid else None
        if inst_id not in state["player_skills"]:
            title = info["title"] if info else inst_id
            tier = info["tier"] if info else "Unknown"
            socket_idx = state["next_player_skill"]
            state["next_player_skill"] = socket_idx + 1
            if socket_idx < 12:
                state["player_skills"][inst_id] = {
                    "title": title,
                    "tier": tier,
                    "socket": socket_idx,
                }
                logger.info("* skill selected %s -> slot %d", title, socket_idx)
                return True
        return False

    # State changes
    m = RE_STATE_CHANGE.search(line)
    if m:
        from_state, to_state = m.groups()
        logger.info("State: %s -> %s", from_state, to_state)

        if to_state == "StartRunAppState":
            # New run — clear everything
            state["player_board"].clear()
            state["opponent_board"].clear()
            state["player_skills"].clear()
            state["shop_cards"].clear()
            state["instance_map"].clear()
            state["next_player_skill"] = 0
            state["show_overlay"] = False
            return True

        if to_state == "ChoiceState":
            # New shop phase — clear opponent board + shop
            state["opponent_board"].clear()
            state["shop_cards"].clear()

        state["show_overlay"] = to_state in GAME_STATES

        return True

    return False


def build_initial_state(log_path: Path, card_db: dict) -> dict:
    """Parse full log to build current game state."""
    state = new_state()

    with open(log_path, errors="replace") as f:
        for line in f:
            process_line(line.strip(), state, card_db, debug=False)

    return state


def tail_log(log_path: Path, card_db: dict, config: configparser.ConfigParser, debug: bool):
    """Tail the log file and track game state."""
    ebs_url = config["ebs"]["url"]
    channel_id = config["ebs"]["channel_id"]
    secret = os.environ.get("EBS_SECRET") or config["ebs"]["secret"]

    logger.info("Building initial state from log...")
    state = build_initial_state(log_path, card_db)

    p_items = [v["title"] for v in state["player_board"].values()]
    p_skills = [v["title"] for v in state["player_skills"].values()]
    logger.info("Initial items: %s", p_items)
    logger.info("Initial skills: %s", p_skills)

    if state["show_overlay"]:
        send_state(ebs_url, channel_id, secret, state)

    logger.info("Watching %s", log_path)

    with open(log_path, errors="replace") as f:
        f.seek(0, 2)
        last_inode = log_path.stat().st_ino
        last_size = log_path.stat().st_size

        while True:
            try:
                line = f.readline()
                if not line:
                    time.sleep(0.1)
                    # Check for log rotation or truncation
                    try:
                        st = log_path.stat()
                    except FileNotFoundError:
                        logger.warning("Log file disappeared, waiting...")
                        time.sleep(1)
                        continue
                    if st.st_ino != last_inode or st.st_size < last_size:
                        logger.info("Log rotated/truncated, reopening...")
                        f.close()
                        f = open(log_path, errors="replace")
                        last_inode = st.st_ino
                        last_size = st.st_size
                    else:
                        last_size = st.st_size
                    continue

                last_size = log_path.stat().st_size
                line = line.strip()
                if process_line(line, state, card_db, debug):
                    send_state(ebs_url, channel_id, secret, state)
            except Exception as e:
                logger.error("Tail loop error: %s", e)
                time.sleep(1)


def main():
    parser = argparse.ArgumentParser(description="Bazaar log watcher companion")
    parser.add_argument("--config", type=Path, default=Path(__file__).parent / "config.ini")
    parser.add_argument("--log", type=Path, default=DEFAULT_LOG)
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    if not args.config.exists():
        logger.error("Config not found: %s", args.config)
        raise SystemExit(1)

    config = configparser.ConfigParser()
    config.read(args.config)

    game_cards = (
        Path.home()
        / ".local/share/Steam/steamapps/common/The Bazaar"
        / "TheBazaar_Data/StreamingAssets/cards.json"
    )
    if not game_cards.exists():
        logger.error("Game cards.json not found: %s", game_cards)
        raise SystemExit(1)

    card_db = load_card_db(game_cards)

    if not args.log.exists():
        logger.error("Player.log not found: %s", args.log)
        raise SystemExit(1)

    tail_log(args.log, card_db, config, args.debug)


if __name__ == "__main__":
    main()
