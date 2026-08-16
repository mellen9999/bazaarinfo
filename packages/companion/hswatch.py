"""
hswatch.py — Watch Hearthstone's Power.log for Battlegrounds board state.

The sibling of the Bazaar watcher in logwatch.py, and the same contract: read only
the log file the game writes on its own. No memory reading, no injection, no
modification, nothing touching the game process.

WHY THIS EXISTS: the bot could answer "what's on his board" during a Bazaar stream
and not during a Battlegrounds one. The HDT Twitch extension shows viewers the board,
but its backend is write-only (POST /send/ signs a PubSub message with HDT's own
extension secret) — there is no read path for anyone else, with or without the
streamer's blessing. So the state has to come from the log, like everything else here.

WHAT IT SENDS: the local player's board (card ids, stats, keywords, golden), tavern
tier, hero, effective health and leaderboard place, plus the opponent's hero and board
during a combat. Card ids are sent RAW — the bot resolves them to names against the
card set it already refreshes daily, so a rotation never needs a new companion build.

WHAT IT DOES NOT SEND: the shop, the hand, or anything else the streamer has not
already shown every viewer on stream.

Hearthstone only writes Power.log when log.config asks it to. Hearthstone Deck Tracker
writes that config itself, so on a streamer already running HDT this is present with no
setup at all — and ensure_log_config() writes it for anyone who is not.
"""

import gzip
import logging
import os
import re
import sys
import time
from pathlib import Path

logger = logging.getLogger(__name__)

# --- log discovery ---

# Hearthstone writes each session into its own timestamped directory under Logs/.
SESSION_DIR_RE = re.compile(r"^Hearthstone_\d{4}_\d{2}_\d{2}_\d{2}_\d{2}_\d{2}$")
POWER_LOG = "Power.log"


def hearthstone_dirs() -> "list[Path]":
    """Candidate Hearthstone install directories, most likely first."""
    out = []
    if os.name == "nt":
        for env in ("ProgramFiles(x86)", "ProgramFiles"):
            base = os.environ.get(env)
            if base:
                out.append(Path(base) / "Hearthstone")
        for drive in ("C:", "D:", "E:"):
            out.append(Path(f"{drive}/Hearthstone"))
            out.append(Path(f"{drive}/Program Files (x86)/Hearthstone"))
    else:
        home = Path.home()
        out += [
            Path("/Applications/Hearthstone"),
            home / "Applications/Hearthstone",
            # wine/proton prefixes — a linux streamer running HS through Lutris
            home / ".wine/drive_c/Program Files (x86)/Hearthstone",
            home / "Games/hearthstone/drive_c/Program Files (x86)/Hearthstone",
        ]
    return out


def find_power_log(dirs: "list[Path] | None" = None) -> "Path | None":
    """
    Newest session's Power.log, or None when Hearthstone has never run with logging on.

    Picks by directory mtime rather than by parsing the timestamp out of the name: a
    clock change or a locale quirk must not make the companion tail a dead session.
    """
    for base in (dirs if dirs is not None else hearthstone_dirs()):
        logs = base / "Logs"
        try:
            sessions = [d for d in logs.iterdir() if d.is_dir() and SESSION_DIR_RE.match(d.name)]
        except OSError:
            continue
        candidates = [d / POWER_LOG for d in sessions]
        candidates.append(logs / POWER_LOG)  # older builds wrote it flat
        existing = [p for p in candidates if p.is_file()]
        if existing:
            return max(existing, key=lambda p: p.stat().st_mtime)
    return None


def log_config_path() -> Path:
    """Where Hearthstone reads its logging config from."""
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
        return base / "Blizzard/Hearthstone/log.config"
    if sys.platform == "darwin":
        return Path.home() / "Library/Preferences/Blizzard/Hearthstone/log.config"
    return Path.home() / ".local/share/Blizzard/Hearthstone/log.config"


LOG_CONFIG_BLOCK = (
    "[Power]\n"
    "LogLevel=1\n"
    "FilePrinting=true\n"
    "ConsolePrinting=false\n"
    "ScreenPrinting=false\n"
    "Verbose=true\n"
)


def ensure_log_config(path: "Path | None" = None) -> bool:
    """
    Make sure Hearthstone writes Power.log. Returns True when the config already asked
    for it or we just added it; False when we could not write.

    Appends a [Power] section rather than rewriting the file — HDT and other trackers
    keep their own sections in here, and clobbering them would break the streamer's
    existing setup to fix ours. Takes effect on the next Hearthstone launch.
    """
    p = path or log_config_path()
    try:
        existing = p.read_text(encoding="utf-8") if p.exists() else ""
    except OSError as e:
        logger.warning("hs: could not read log.config (%s)", e)
        return False
    if re.search(r"^\[Power\]", existing, re.MULTILINE):
        return True
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        sep = "" if (not existing or existing.endswith("\n")) else "\n"
        p.write_text(existing + sep + LOG_CONFIG_BLOCK, encoding="utf-8")
    except OSError as e:
        logger.warning("hs: could not write log.config (%s)", e)
        return False
    logger.info("hs: enabled Power logging in %s (takes effect next Hearthstone launch)", p)
    return True


# --- log parsing ---
#
# Every state line looks like:
#   D 15:43:52.3262200 GameState.DebugPrintPower() -     TAG_CHANGE Entity=... tag=X value=Y
#
# PowerTaskList.DebugPrintPower() carries the same packets a moment later; taking only
# GameState halves the work and removes any chance of applying a change twice.

SOURCE = "GameState.DebugPrintPower()"

RE_CREATE_GAME = re.compile(r"^\s*CREATE_GAME\s*$")
RE_GAME_ENTITY = re.compile(r"^\s*GameEntity EntityID=(\d+)")
RE_PLAYER = re.compile(r"^\s*Player EntityID=(\d+) PlayerID=(\d+)")
RE_FULL_ENTITY = re.compile(r"^\s*FULL_ENTITY - Creating ID=(\d+) CardID=(\S*)")
RE_SHOW_ENTITY = re.compile(r"^\s*SHOW_ENTITY - Updating Entity=(\[.*?\]|\d+) CardID=(\S*)")
RE_TAG = re.compile(r"^\s*tag=(\S+) value=(\S+)\s*$")
RE_TAG_CHANGE = re.compile(r"^\s*TAG_CHANGE Entity=(\[.*?\]|\S+) tag=(\S+) value=(\S+)")
RE_BRACKET_ID = re.compile(r"\bid=(\d+)")

# Tags worth keeping. Everything else is dropped at parse time so a long game cannot
# grow an unbounded per-entity dict on the streamer's machine.
KEEP_TAGS = frozenset({
    "CONTROLLER", "CARDTYPE", "ZONE", "ZONE_POSITION", "PLAYER_ID", "HERO_ENTITY",
    "BACON_DUMMY_PLAYER", "PLAYER_TECH_LEVEL", "TECH_LEVEL", "PLAYER_LEADERBOARD_PLACE",
    "ATK", "HEALTH", "DAMAGE", "ARMOR", "PREMIUM",
    "TAUNT", "DIVINE_SHIELD", "POISONOUS", "VENOMOUS", "WINDFURY", "MEGA_WINDFURY",
    "REBORN", "STEALTH", "CHARGE",
})

KEYWORD_TAGS = (
    ("TAUNT", "taunt"),
    ("DIVINE_SHIELD", "divine shield"),
    ("POISONOUS", "poisonous"),
    ("VENOMOUS", "venomous"),
    ("WINDFURY", "windfury"),
    ("MEGA_WINDFURY", "mega windfury"),
    ("REBORN", "reborn"),
    ("STEALTH", "stealth"),
)

MAX_BOARD = 7


def new_hs_state() -> dict:
    """Fresh parser state. One of these per Hearthstone game."""
    return {
        "entities": {},   # entity id -> {"card": str|None, "tags": {}}
        "players": {},    # controller id -> {"entity": int, "hero": int|None, "dummy": bool}
        "turn": 0,
        "in_game": False,
        "_cur": None,     # entity id currently receiving indented tag lines
    }


def _entity(state: dict, eid: int) -> dict:
    e = state["entities"].get(eid)
    if e is None:
        e = {"card": None, "tags": {}}
        state["entities"][eid] = e
    return e


def _ref_id(ref: str) -> "int | None":
    """Resolve an Entity= reference to an entity id, or None when it isn't one.

    Three forms appear: a bare id, a [entityName=… id=N …] bracket, and a bare PLAYER
    NAME. The name form only ever carries player bookkeeping (gold, mulligan state,
    whose turn it is) — none of which is sent — so it is deliberately unresolved rather
    than mapped, and the streamer's battletag never enters this process's memory.
    """
    if ref.startswith("["):
        m = RE_BRACKET_ID.search(ref)
        return int(m.group(1)) if m else None
    return int(ref) if ref.isdigit() else None


def strip_source(line: str) -> "str | None":
    """The packet body of a GameState power line, or None for every other line."""
    if SOURCE not in line:
        return None
    _, sep, body = line.partition(" - ")
    return body.rstrip("\n") if sep else None


def feed_line(state: dict, line: str) -> bool:
    """
    Apply one raw log line. Returns True when it changed something worth re-sending.

    Tolerant by design: an unrecognised line is skipped, never fatal. Blizzard reshapes
    these packets across patches and the companion must degrade to a stale board rather
    than crash on a streamer's machine mid-game.
    """
    body = strip_source(line)
    if body is None:
        return False

    if RE_CREATE_GAME.match(body):
        state.clear()
        state.update(new_hs_state())
        state["in_game"] = True
        return True

    m = RE_GAME_ENTITY.match(body)
    if m:
        state["_cur"] = None  # game-level tags are read from TAG_CHANGE, not this block
        return False

    m = RE_PLAYER.match(body)
    if m:
        eid, pid = int(m.group(1)), int(m.group(2))
        state["_cur"] = eid
        _entity(state, eid)["tags"]["PLAYER_ID"] = str(pid)
        state["players"].setdefault(pid, {"entity": eid, "hero": None, "dummy": False})
        return True

    m = RE_FULL_ENTITY.match(body)
    if m:
        eid = int(m.group(1))
        state["_cur"] = eid
        _entity(state, eid)["card"] = m.group(2) or None
        return True

    m = RE_SHOW_ENTITY.match(body)
    if m:
        eid = _ref_id(m.group(1))
        state["_cur"] = eid
        if eid is not None:
            _entity(state, eid)["card"] = m.group(2) or None
        return True

    m = RE_TAG.match(body)
    if m:
        eid = state["_cur"]
        if eid is None:
            return False
        tag, value = m.group(1), m.group(2)
        if tag in KEEP_TAGS:
            _apply(state, eid, tag, value)
        return True

    m = RE_TAG_CHANGE.match(body)
    if m:
        state["_cur"] = None
        ref, tag, value = m.group(1), m.group(2), m.group(3)
        if ref == "GameEntity":
            if tag == "TURN" and value.isdigit():
                state["turn"] = int(value)
                return True
            return False
        eid = _ref_id(ref)
        if eid is None or tag not in KEEP_TAGS:
            return False
        _apply(state, eid, tag, value)
        return True

    # BLOCK_START / META_DATA / anything else: not state we keep, and it ends any
    # open tag block so a stray indented line can't be misfiled onto the last entity.
    state["_cur"] = None
    return False


def _apply(state: dict, eid: int, tag: str, value: str) -> None:
    ent = _entity(state, eid)
    ent["tags"][tag] = value
    if tag == "BACON_DUMMY_PLAYER":
        pid = ent["tags"].get("PLAYER_ID")
        if pid and pid.isdigit():
            state["players"].setdefault(int(pid), {"entity": eid, "dummy": False})["dummy"] = value == "1"


# --- state → payload ---


def _int(tags: dict, key: str, default: int = 0) -> int:
    v = tags.get(key)
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def local_controller(state: dict) -> "int | None":
    """
    The controller id of the streamer's own player.

    In Battlegrounds the client is told about exactly two players: the streamer, and a
    dummy standing in for whoever they are looking at (Bartender Bob in the shop, the
    real opponent in combat). BACON_DUMMY_PLAYER marks the stand-in, so the other one is
    the streamer. With no dummy flagged yet there is no safe answer — returning None and
    sending nothing beats guessing and reporting an opponent's board as the streamer's.
    """
    real = [pid for pid, p in state["players"].items() if not p["dummy"]]
    dummies = [pid for pid, p in state["players"].items() if p["dummy"]]
    if len(real) == 1 and dummies:
        return real[0]
    return None


def dummy_controller(state: dict) -> "int | None":
    dummies = [pid for pid, p in state["players"].items() if p["dummy"]]
    return dummies[0] if len(dummies) == 1 else None


def board_for(state: dict, controller: int) -> list:
    """Minions in play for one controller, left to right."""
    rows = []
    for eid, e in state["entities"].items():
        t = e["tags"]
        if t.get("CARDTYPE") != "MINION" or t.get("ZONE") != "PLAY":
            continue
        if _int(t, "CONTROLLER", -1) != controller:
            continue
        pos = _int(t, "ZONE_POSITION")
        if not 1 <= pos <= MAX_BOARD:
            continue
        hp = _int(t, "HEALTH") - _int(t, "DAMAGE")
        card = {
            "id": e["card"],
            "pos": pos,
            "atk": _int(t, "ATK"),
            "hp": max(hp, 0),
        }
        if t.get("PREMIUM") == "1":
            card["golden"] = True
        tier = _int(t, "TECH_LEVEL")
        if tier:
            card["tier"] = tier
        kw = [label for tag, label in KEYWORD_TAGS if t.get(tag) == "1"]
        if kw:
            card["kw"] = kw
        rows.append(card)
    rows.sort(key=lambda c: c["pos"])
    return rows


# Bartender Bob holds the opponent slot during the shop phase. He is scenery, not a
# player, and reporting him as "who he's fighting" would be a confident lie.
BOB = "TB_BaconShopBob"
# the unchosen placeholder every player starts on, before the hero draft resolves
HERO_PLACEHOLDER = "TB_BaconShop_HERO_PH"


def _describe_hero(e: dict) -> dict:
    t = e["tags"]
    hp = _int(t, "HEALTH") - _int(t, "DAMAGE")
    hero = {"id": e["card"], "hp": max(hp, 0)}
    for key, tag in (("armor", "ARMOR"), ("tier", "PLAYER_TECH_LEVEL"), ("place", "PLAYER_LEADERBOARD_PLACE")):
        v = _int(t, tag)
        if v:
            hero[key] = v
    return hero


def hero_for(state: dict, controller: int) -> "dict | None":
    """
    The hero a controller is actually playing.

    Read off the entity in ZONE=PLAY rather than the player's HERO_ENTITY tag: that tag
    is only ever updated through the player-NAME reference form, which this parser
    deliberately does not resolve (see _ref_id). Zone is also the more honest signal —
    it is what the client itself is showing.
    """
    best = None
    for e in state["entities"].values():
        t = e["tags"]
        if t.get("CARDTYPE") != "HERO" or t.get("ZONE") != "PLAY":
            continue
        if _int(t, "CONTROLLER", -1) != controller:
            continue
        if e["card"] in (HERO_PLACEHOLDER, BOB):
            continue
        # a hero carrying real player state outranks a bare one — the draft leaves
        # several HERO entities lying around and only the live one has armor/tier/place
        score = sum(1 for tag in ("ARMOR", "PLAYER_TECH_LEVEL", "PLAYER_LEADERBOARD_PLACE") if _int(t, tag))
        if best is None or score > best[0]:
            best = (score, e)
    return _describe_hero(best[1]) if best else None


def lobby(state: dict) -> list:
    """
    Every OTHER player still tracked in the game, by leaderboard place.

    The client is told about all eight heroes — the seven it isn't currently facing sit
    in SETASIDE carrying their real armor, tavern tier and placement. That is the answer
    to "who's left" and "what place is he in", and it costs nothing extra to read.
    """
    me = local_controller(state)
    rows = []
    for e in state["entities"].values():
        t = e["tags"]
        if t.get("CARDTYPE") != "HERO" or e["card"] in (None, BOB, HERO_PLACEHOLDER):
            continue
        place = _int(t, "PLAYER_LEADERBOARD_PLACE")
        if not place:
            continue
        if me is not None and _int(t, "CONTROLLER", -1) == me and t.get("ZONE") == "PLAY":
            continue  # the streamer's own hero is reported separately
        rows.append(_describe_hero(e))
    # one entry per place: the same seat can appear under more than one entity across a
    # hero swap, and the richest record is the one worth keeping
    by_place = {}
    for r in rows:
        prev = by_place.get(r["place"])
        if prev is None or len(r) > len(prev):
            by_place[r["place"]] = r
    return [by_place[p] for p in sorted(by_place)]


def snapshot(state: dict) -> "dict | None":
    """
    The payload to send, or None when there is nothing trustworthy to say.

    None rather than an empty board on purpose: "no data" and "an empty board" mean
    very different things to a chatter, and the bot must never be handed the second
    when the truth is the first.
    """
    if not state["in_game"]:
        return None
    me = local_controller(state)
    if me is None:
        return None
    hero = hero_for(state, me)
    board = board_for(state, me)
    if hero is None and not board:
        return None

    out = {"turn": state["turn"], "board": board}
    if hero:
        out["hero"] = hero

    # Shop or fight. In the shop the opponent slot is Bartender Bob, and the minions
    # still sitting on his side are the LAST fight's board, not anything live — which is
    # exactly why nothing about the opponent is reported unless a real hero is standing
    # there. A stale board relayed as the current one is the most convincing kind of wrong.
    them = dummy_controller(state)
    opp_hero = hero_for(state, them) if them is not None else None
    out["phase"] = "combat" if opp_hero else "shop"
    if opp_hero:
        out["opponent"] = {"hero": opp_hero}
        opp_board = board_for(state, them)
        if opp_board:
            out["opponent"]["board"] = opp_board

    others = lobby(state)
    if others:
        out["lobby"] = others
    return out


def parse_log(lines) -> dict:
    """Run a whole log through the parser. Used by the initial catch-up read and tests."""
    state = new_hs_state()
    for line in lines:
        feed_line(state, line)
    return state


def open_log(path: Path):
    """Text handle for a log, transparently handling the gzipped test fixture."""
    if str(path).endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8", errors="replace")
    return open(path, encoding="utf-8", errors="replace")


# --- sending ---

# The Battlegrounds board changes far less often than a Bazaar shop: one recruit phase
# of shuffling minions, then a combat. A heartbeat well under the bot's staleness window
# keeps the answer honest without spending the channel's rate budget on nothing.
HS_HEARTBEAT_S = 30
# how often to look for a newer Hearthstone session (see the tail loop)
ROTATION_CHECK_S = 5
_session = None


def _http():
    global _session
    if _session is None:
        import requests
        _session = requests.Session()
    return _session


def send_hs_state(ebs_url: str, channel_id: str, secret: str, payload: "dict | None") -> bool:
    """POST one Battlegrounds snapshot. Returns True on success.

    A None payload is still sent, as an explicit clear: when the streamer leaves a game
    the bot must stop describing the board they left, and silence would leave the last
    one standing until it aged out.
    """
    try:
        r = _http().post(
            f"{ebs_url}/hs",
            json={"channelId": channel_id, "secret": secret, "hs": payload},
            timeout=5,
        )
        if r.ok:
            n = len(payload.get("board", [])) if payload else 0
            logger.info("hs: sent %s (%d minions)", payload.get("phase", "-") if payload else "no game", n)
            return True
        logger.warning("hs: EBS returned %d: %s", r.status_code, r.text[:200])
        return False
    except Exception as e:
        logger.error("hs: send failed: %s", e)
        return False


def watch(log_path: Path, ebs_url: str, channel_id: str, secret: str) -> None:
    """
    Tail Hearthstone's Power.log and keep the EBS in sync with the live board.

    Mirrors the Bazaar watcher's loop deliberately — same coalescing, same heartbeat,
    same rotation handling — because those behaviours were all learned the hard way
    there and a second, subtly different loop would relearn them.
    """
    from logwatch import should_flush, backoff_delay  # imported here: logwatch owns us

    logger.info("hs: watching %s", log_path)
    state = new_hs_state()
    try:
        with open_log(log_path) as f:
            for line in f:
                feed_line(state, line)
    except OSError as e:
        logger.warning("hs: could not read back the log (%s), starting from live lines", e)

    last_sent = None
    # start the clock in the past so the first flush below is due immediately
    last_send = 0.0
    last_change = 0.0
    dirty = False
    fail_count = 0
    next_retry_ok = 0.0
    last_rotation_check = 0.0

    def flush(force: bool = False) -> None:
        nonlocal dirty, last_send, fail_count, next_retry_ok, last_sent
        now = time.monotonic()
        if not force and not should_flush(dirty, now, last_change, last_send):
            return
        if now < next_retry_ok:
            return
        payload = snapshot(state)
        # nothing actually changed in what we'd SAY — a thousand log lines can move no
        # visible state, and the bot gains nothing from re-hearing the same board
        if not force and payload == last_sent:
            dirty = False
            return
        if send_hs_state(ebs_url, channel_id, secret, payload):
            last_sent = payload
            dirty = False
            last_send = now
            fail_count = 0
        else:
            fail_count += 1
            next_retry_ok = now + backoff_delay(fail_count)

    # send what the catch-up read found straight away. the companion is usually started
    # mid-session, and waiting for the next log line (or the 30s heartbeat) to report a
    # board that is already on screen is a needless blind window.
    flush(force=True)

    f = open_log(log_path)
    f.seek(0, 2)

    try:
        while True:
            try:
                line = f.readline()
                if not line:
                    time.sleep(0.1)
                    flush()
                    now = time.monotonic()
                    if not dirty and (now - last_send) >= HS_HEARTBEAT_S:
                        flush(force=True)

                    # a new Hearthstone session writes a NEW log in a new directory, so
                    # rotation here means "look for a newer session", not "reopen this file".
                    # this walks the Logs/ tree, and the idle branch runs ten times a
                    # second — checking every tick would be a directory scan 10x/s for the
                    # entire time the companion is open. a new session is a human-scale
                    # event; a few seconds late costs nothing.
                    now = time.monotonic()
                    if now - last_rotation_check < ROTATION_CHECK_S:
                        continue
                    last_rotation_check = now
                    newest = find_power_log()
                    try:
                        st = log_path.stat()
                    except FileNotFoundError:
                        st = None
                    rotated = bool(newest and newest != log_path)
                    truncated = bool(st and st.st_size < f.tell())
                    if rotated or truncated:
                        logger.info("hs: log rotated, following %s", newest or log_path)
                        f.close()
                        time.sleep(0.5)
                        log_path = newest or log_path
                        while True:
                            try:
                                state = new_hs_state()
                                f = open_log(log_path)
                                # read the new session from the TOP, not from the end. we
                                # may notice a rotation minutes late, and CREATE_GAME is
                                # what establishes which player is the streamer — skip it
                                # and the board stays unreadable until the next game.
                                for old in f:
                                    feed_line(state, old)
                                break
                            except OSError as e:
                                logger.warning("hs: log unreadable after rotation (%s) — retrying in 2s", e)
                                time.sleep(2)
                        dirty = True
                        last_change = time.monotonic()
                        last_sent = None
                    continue

                if feed_line(state, line):
                    dirty = True
                    last_change = time.monotonic()
                flush()
            except Exception as e:
                logger.error("hs: tail loop error: %s", e)
                time.sleep(1)
    finally:
        try:
            f.close()
        except Exception:
            pass


def start(ebs_url: str, channel_id: str, secret: str) -> bool:
    """
    Start the Battlegrounds watcher on a background thread, if Hearthstone is here.

    Returns False and stays silent when it isn't — the overwhelming majority of
    streamers running this companion play The Bazaar and nothing else, and a missing
    Hearthstone is not a problem to report.
    """
    import threading

    log_path = find_power_log()
    if not log_path:
        # config first: a streamer with Hearthstone installed but Power logging off has
        # no log to find yet, and this is what makes one exist on their next launch
        if any(d.exists() for d in hearthstone_dirs()):
            ensure_log_config()
            logger.info("hs: Hearthstone found but no Power.log yet — logging enabled, restart Hearthstone")
        return False

    ensure_log_config()
    t = threading.Thread(
        target=watch, args=(log_path, ebs_url, channel_id, secret),
        name="hswatch", daemon=True,
    )
    t.start()
    return True
