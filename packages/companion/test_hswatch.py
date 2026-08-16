"""
Tests for the Battlegrounds watcher.

The important ones run against testdata/bg_power.log.gz — a real, redacted Power.log
from seven turns of an actual Battlegrounds game. A parser for a format we do not
control is only worth what it does on the real thing; hand-written lines can only ever
confirm the shape we already assumed.
"""

import gzip
from pathlib import Path

import pytest

import hswatch

FIXTURE = Path(__file__).parent / "testdata" / "bg_power.log.gz"


@pytest.fixture(scope="module")
def state():
    with hswatch.open_log(FIXTURE) as f:
        return hswatch.parse_log(f)


@pytest.fixture(scope="module")
def snap(state):
    return hswatch.snapshot(state)


# --- against the real log ---


def test_finds_both_players_and_tells_them_apart(state):
    assert hswatch.local_controller(state) == 6
    assert hswatch.dummy_controller(state) == 14


def test_reads_the_streamers_own_board(snap):
    assert [c["id"] for c in snap["board"]] == ["BGS_071", "BGS_049"]
    assert snap["board"][0] == {
        "id": "BGS_071", "pos": 1, "atk": 3, "hp": 2, "tier": 3, "kw": ["divine shield"],
    }


def test_reads_the_hero_that_is_actually_being_played(snap):
    # NOT the TB_BaconShop_HERO_PH placeholder every player starts on, and not one of
    # the discarded draft options — the one standing in PLAY with the live player state
    assert snap["hero"] == {
        "id": "BG23_HERO_305_SKIN_B", "hp": 30, "armor": 9, "tier": 3, "place": 2,
    }


def test_tracks_the_turn(snap):
    assert snap["turn"] == 7


def test_reads_the_rest_of_the_lobby(snap):
    places = [p["place"] for p in snap["lobby"]]
    assert places == [1, 3, 4, 5, 6, 7, 8]  # every seat but the streamer's own (2nd)
    assert snap["lobby"][0]["id"] == "TB_BaconShop_HERO_62"
    dead = snap["lobby"][-1]
    assert dead["place"] == 8 and dead["hp"] == 0


def test_shop_phase_reports_no_opponent(snap):
    # the fixture ends in the shop. minions are still sitting on the dummy's side from
    # the last fight — relaying those as the live opponent is the bug this guards
    assert snap["phase"] == "shop"
    assert "opponent" not in snap


def test_combat_is_detected_with_a_real_opponent():
    st = hswatch.new_hs_state()
    saw_combat = None
    with hswatch.open_log(FIXTURE) as f:
        for line in f:
            hswatch.feed_line(st, line)
            s = hswatch.snapshot(st)
            if s and s.get("phase") == "combat":
                saw_combat = s
                break
    assert saw_combat is not None, "never entered combat across seven real turns"
    assert saw_combat["opponent"]["hero"]["id"] not in (hswatch.BOB, hswatch.HERO_PLACEHOLDER)


def test_never_reports_bartender_bob_as_an_opponent():
    st = hswatch.new_hs_state()
    with hswatch.open_log(FIXTURE) as f:
        for line in f:
            hswatch.feed_line(st, line)
            s = hswatch.snapshot(st)
            if s and "opponent" in s:
                assert s["opponent"]["hero"]["id"] != hswatch.BOB


def test_entity_count_stays_bounded(state):
    # KEEP_TAGS is what stops a long game growing an unbounded dict on a streamer's PC
    for e in state["entities"].values():
        assert set(e["tags"]) <= hswatch.KEEP_TAGS


# --- parser rules, in isolation ---


def _line(body):
    return f"D 15:43:52.3262200 GameState.DebugPrintPower() - {body}"


def test_only_gamestate_lines_are_read():
    st = hswatch.new_hs_state()
    dup = "D 15:43:52.3 PowerTaskList.DebugPrintPower() -     TAG_CHANGE Entity=1 tag=ATK value=9"
    assert hswatch.feed_line(st, dup) is False
    assert st["entities"] == {}


def test_a_player_name_reference_is_never_resolved():
    # these carry the streamer's battletag; nothing needed from them, so nothing read
    assert hswatch._ref_id("dymitrq#2316") is None
    assert hswatch._ref_id("[entityName=Sellemental id=42 zone=PLAY]") == 42
    assert hswatch._ref_id("357") == 357


def test_create_game_resets_everything():
    st = hswatch.new_hs_state()
    hswatch.feed_line(st, _line("    FULL_ENTITY - Creating ID=5 CardID=BGS_071"))
    assert st["entities"]
    hswatch.feed_line(st, _line("CREATE_GAME"))
    assert st["entities"] == {}
    assert st["in_game"] is True


def test_an_unparseable_line_closes_the_open_tag_block():
    st = hswatch.new_hs_state()
    hswatch.feed_line(st, _line("    FULL_ENTITY - Creating ID=5 CardID=BGS_071"))
    hswatch.feed_line(st, _line("    BLOCK_START BlockType=PLAY Entity=[id=9]"))
    hswatch.feed_line(st, _line("        tag=ATK value=99"))
    assert "ATK" not in st["entities"][5]["tags"]


def test_damage_is_subtracted_from_health():
    st = hswatch.new_hs_state()
    for body in (
        "CREATE_GAME",
        "    Player EntityID=17 PlayerID=6",
        "    Player EntityID=18 PlayerID=14",
        "        tag=BACON_DUMMY_PLAYER value=1",
        "    FULL_ENTITY - Creating ID=5 CardID=BGS_071",
        "        tag=CONTROLLER value=6",
        "        tag=CARDTYPE value=MINION",
        "        tag=ZONE value=PLAY",
        "        tag=ZONE_POSITION value=1",
        "        tag=ATK value=4",
        "        tag=HEALTH value=6",
        "        tag=DAMAGE value=2",
    ):
        hswatch.feed_line(st, _line(body))
    assert hswatch.board_for(st, 6) == [{"id": "BGS_071", "pos": 1, "atk": 4, "hp": 4}]


def test_a_minion_off_the_board_is_not_on_the_board():
    st = hswatch.new_hs_state()
    for body in (
        "CREATE_GAME",
        "    FULL_ENTITY - Creating ID=5 CardID=BGS_071",
        "        tag=CONTROLLER value=6",
        "        tag=CARDTYPE value=MINION",
        "        tag=ZONE value=HAND",
        "        tag=ZONE_POSITION value=1",
    ):
        hswatch.feed_line(st, _line(body))
    assert hswatch.board_for(st, 6) == []


def test_golden_is_reported():
    st = hswatch.new_hs_state()
    for body in (
        "CREATE_GAME",
        "    FULL_ENTITY - Creating ID=5 CardID=BGS_071",
        "        tag=CONTROLLER value=6",
        "        tag=CARDTYPE value=MINION",
        "        tag=ZONE value=PLAY",
        "        tag=ZONE_POSITION value=1",
        "        tag=PREMIUM value=1",
    ):
        hswatch.feed_line(st, _line(body))
    assert hswatch.board_for(st, 6)[0]["golden"] is True


def test_no_snapshot_before_the_players_are_known():
    st = hswatch.new_hs_state()
    assert hswatch.snapshot(st) is None
    hswatch.feed_line(st, _line("CREATE_GAME"))
    # in a game, but with no dummy flagged there is no way to tell whose board is whose
    assert hswatch.snapshot(st) is None


# --- log discovery / config ---


def test_find_power_log_picks_the_newest_session(tmp_path):
    logs = tmp_path / "Logs"
    old = logs / "Hearthstone_2026_08_01_10_00_00"
    new = logs / "Hearthstone_2026_08_02_10_00_00"
    for d in (old, new):
        d.mkdir(parents=True)
        (d / "Power.log").write_text("x")
    import os
    os.utime(old / "Power.log", (1, 1))
    os.utime(new / "Power.log", (2, 2))
    assert hswatch.find_power_log([tmp_path]) == new / "Power.log"


def test_find_power_log_returns_none_when_hearthstone_is_absent(tmp_path):
    assert hswatch.find_power_log([tmp_path / "nope"]) is None


def test_ensure_log_config_appends_without_clobbering_other_trackers(tmp_path):
    cfg = tmp_path / "log.config"
    cfg.write_text("[Zone]\nLogLevel=1\nFilePrinting=true\n")
    assert hswatch.ensure_log_config(cfg) is True
    text = cfg.read_text()
    assert "[Zone]" in text  # HDT's own section survives
    assert "[Power]" in text and "FilePrinting=true" in text


def test_ensure_log_config_leaves_an_existing_power_section_alone(tmp_path):
    cfg = tmp_path / "log.config"
    cfg.write_text("[Power]\nLogLevel=1\nFilePrinting=true\nCustom=1\n")
    before = cfg.read_text()
    assert hswatch.ensure_log_config(cfg) is True
    assert cfg.read_text() == before


def test_ensure_log_config_creates_the_file_when_missing(tmp_path):
    cfg = tmp_path / "deep" / "log.config"
    assert hswatch.ensure_log_config(cfg) is True
    assert "[Power]" in cfg.read_text()


# --- the fixture itself ---


def test_fixture_carries_no_personal_data():
    """The log format embeds battletags. Anything committed here must not."""
    import re
    text = gzip.open(FIXTURE, "rt", encoding="utf-8").read()
    assert not re.search(r"\w+#\d{3,}", text), "a battletag survived redaction"
    assert "GameAccountId=[hi=0 lo=0]" in text, "account ids must be zeroed, not real"
    assert not re.search(r"hi=[1-9]\d{3,}", text)
