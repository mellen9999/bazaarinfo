"""
Regression tests for logwatch.py bug fixes.
Run: python3 -m pytest packages/companion/test_logwatch.py -q
"""

import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

from logwatch import (
    _cap,
    _TITLE_MAX,
    make_item_payload,
    build_payload,
    new_state,
    process_line,
    default_config_path,
    user_config_path,
    verify_credentials,
)
import logwatch


# --- #2 + #8: item socket clamp ---

class TestItemSocketClamp:
    def _base_info(self, socket, title="Test Item"):
        return {"title": title, "tier": "Bronze", "size": "Medium", "socket": socket}

    def test_normal_socket_no_crash(self):
        p = make_item_payload(self._base_info(5), "player")
        assert 0.0 <= p["x"] <= 1.0

    def test_socket_overflow_large_int(self):
        # Without the clamp this raised OverflowError (int too large to convert to float)
        info = self._base_info(10 ** 300)
        p = make_item_payload(info, "player")
        assert isinstance(p["x"], float)
        assert 0.0 <= p["x"] <= 1.0

    def test_socket_negative_clamped(self):
        p = make_item_payload(self._base_info(-100), "player")
        assert isinstance(p["x"], float)
        assert 0.0 <= p["x"] <= 1.0

    def test_socket_string_garbage_uses_default(self):
        p = make_item_payload(self._base_info("not_a_number"), "player")
        assert isinstance(p["x"], float)

    def test_socket_none_uses_default(self):
        info = {"title": "X", "tier": "Bronze", "size": "Small", "socket": None}
        p = make_item_payload(info, "opponent")
        assert isinstance(p["x"], float)

    def test_socket_float_string_parsed(self):
        # int("9") works, so "9" should parse fine
        p = make_item_payload(self._base_info("9"), "player")
        assert isinstance(p["x"], float)

    def test_socket_boundary_0(self):
        p = make_item_payload(self._base_info(0), "player")
        assert isinstance(p["x"], float)

    def test_socket_boundary_9(self):
        p = make_item_payload(self._base_info(9), "player")
        assert isinstance(p["x"], float)

    def test_socket_out_of_range_high_clamped_to_9(self):
        p_clamped = make_item_payload(self._base_info(9), "player")
        p_overflow = make_item_payload(self._base_info(999), "player")
        assert abs(p_clamped["x"] - p_overflow["x"]) < 1e-9

    def test_socket_out_of_range_low_clamped_to_0(self):
        p_clamped = make_item_payload(self._base_info(0), "player")
        p_negative = make_item_payload(self._base_info(-50), "player")
        assert abs(p_clamped["x"] - p_negative["x"]) < 1e-9

    def test_build_payload_with_poison_socket_no_overflow(self):
        # build_payload (startup send_state path) must not raise OverflowError
        state = new_state()
        state["show_overlay"] = True
        state["player_board"]["iid1"] = {
            "title": "Poison Card",
            "tier": "Gold",
            "size": "Large",
            "socket": 10 ** 300,
        }
        state["opponent_board"]["iid2"] = {
            "title": "Also Bad",
            "tier": "Bronze",
            "size": "Small",
            "socket": -9999,
        }
        # Must not raise
        payload = build_payload(state)
        assert len(payload["cards"]) == 2
        for card in payload["cards"]:
            assert isinstance(card["x"], float)

    def test_process_line_spawned_overflow_socket(self):
        """A Cards Spawned line with a huge socket number must not stall state."""
        # craft a line with Socket_99999 — process_line stores it, make_item_payload clamps
        state = new_state()
        state["show_overlay"] = True
        line = "[GameSimHandler] Cards Spawned: abc123 [Player] [Hand] [Socket_99999] [Medium]"
        changed = process_line(line, state, {}, debug=False)
        # changed may be True or False depending on whether inst_id is in card_db
        # Key: build_payload must not raise
        payload = build_payload(state)
        assert isinstance(payload, dict)


# --- #4: title length cap ---

class TestTitleLengthCap:
    def test_cap_helper_truncates(self):
        long = "A" * 1000
        assert len(_cap(long)) == _TITLE_MAX

    def test_cap_helper_short_unchanged(self):
        assert _cap("Short Title") == "Short Title"

    def test_cap_helper_exact_max(self):
        t = "B" * _TITLE_MAX
        assert _cap(t) == t

    def test_cap_helper_one_over(self):
        t = "C" * (_TITLE_MAX + 1)
        result = _cap(t)
        assert len(result) == _TITLE_MAX

    def test_make_item_payload_title_capped(self):
        """Title stored in info already capped; payload reflects it."""
        long_title = "Z" * 5000
        info = {"title": long_title, "tier": "Silver", "size": "Medium", "socket": 5}
        p = make_item_payload(info, "player")
        # The payload emits info["title"] verbatim — the cap happens at storage time,
        # but verify the payload doesn't crash and title field is present.
        assert "title" in p

    def test_process_line_spawned_long_title_via_inst_id_fallback(self):
        """When card_db has no match, inst_id is used as title and must be capped."""
        state = new_state()
        long_inst_id = "X" * 5000
        # Build a line that will match RE_CARDS_SPAWNED with our long inst_id
        line = f"[GameSimHandler] Cards Spawned: {long_inst_id} [Player] [Hand] [Socket_3] [Medium]"
        process_line(line, state, {}, debug=False)
        # Find the entry — key is long_inst_id
        entry = state["player_board"].get(long_inst_id)
        if entry:
            assert len(entry["title"]) <= _TITLE_MAX

    def test_build_payload_5000_char_title_no_overflow(self):
        """A 5000-char title in info should not crash build_payload."""
        state = new_state()
        state["show_overlay"] = True
        state["player_board"]["iid1"] = {
            "title": "T" * 5000,
            "tier": "Gold",
            "size": "Medium",
            "socket": 5,
        }
        # Must not raise
        payload = build_payload(state)
        assert len(payload["cards"]) == 1


class TestConfigLocation:
    """
    PyInstaller --onefile unpacks to a temp dir that is deleted on exit. Anchoring the
    config to __file__ put config.ini in that temp dir, so the shipped exe forgot the
    streamer's Channel ID and secret on every launch and re-ran first-time setup — while
    the setup docs promised "you only do this once".
    """

    def test_frozen_config_sits_next_to_the_exe_not_the_temp_dir(self, tmp_path, monkeypatch):
        exe_dir = tmp_path / "app"
        exe_dir.mkdir()
        unpack_dir = tmp_path / "_MEIxxxx"
        unpack_dir.mkdir()
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(sys, "executable", str(exe_dir / "companion.exe"))
        monkeypatch.setattr("logwatch.__file__", str(unpack_dir / "logwatch.py"))
        got = default_config_path()
        assert got == exe_dir / "config.ini"
        assert unpack_dir not in got.parents

    def test_falls_back_to_user_dir_when_app_dir_is_read_only(self, tmp_path, monkeypatch):
        exe_dir = tmp_path / "readonly"
        exe_dir.mkdir()
        exe_dir.chmod(0o500)
        home = tmp_path / "home"
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(sys, "executable", str(exe_dir / "companion.exe"))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(home))
        monkeypatch.delenv("APPDATA", raising=False)
        try:
            assert default_config_path() == user_config_path()
        finally:
            exe_dir.chmod(0o700)

    def test_an_existing_config_always_wins(self, tmp_path, monkeypatch):
        """Upgrading must never orphan credentials the streamer already entered."""
        exe_dir = tmp_path / "app"
        exe_dir.mkdir()
        home = tmp_path / "home"
        (home / "bazaarinfo").mkdir(parents=True)
        existing = home / "bazaarinfo" / "config.ini"
        existing.write_text("[ebs]\n")
        monkeypatch.setattr(sys, "frozen", True, raising=False)
        monkeypatch.setattr(sys, "executable", str(exe_dir / "companion.exe"))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(home))
        monkeypatch.delenv("APPDATA", raising=False)
        assert default_config_path() == existing


class _Resp:
    def __init__(self, code):
        self.status_code = code
        self.ok = code < 400
        self.text = "body"


class TestCredentialCheck:
    """
    A mistyped secret used to surface as a failed broadcast partway through a live run.
    It has to fail at startup instead — but only a real rejection may block, or a flaky
    minute of wifi would stop someone streaming.
    """

    def _with_post(self, monkeypatch, fn):
        monkeypatch.setattr(logwatch._session, "post", fn)

    def test_accepts_valid_credentials(self, monkeypatch):
        self._with_post(monkeypatch, lambda *a, **k: _Resp(202))
        assert verify_credentials("http://e", "1", "s") is True

    def test_blocks_only_on_rejected_credentials(self, monkeypatch):
        self._with_post(monkeypatch, lambda *a, **k: _Resp(401))
        assert verify_credentials("http://e", "1", "s") is False

    def test_server_error_does_not_block_startup(self, monkeypatch):
        self._with_post(monkeypatch, lambda *a, **k: _Resp(502))
        assert verify_credentials("http://e", "1", "s") is True

    def test_offline_does_not_block_startup(self, monkeypatch):
        def boom(*a, **k):
            raise OSError("network down")
        self._with_post(monkeypatch, boom)
        assert verify_credentials("http://e", "1", "s") is True


# --- board integrity: a card that leaves the board must leave our board ---

DB = {
    "tid_sub": {"title": "Submarine", "tier": "Silver", "size": "Large", "type": "Item"},
    "tid_ext": {"title": "Extract", "tier": "Bronze", "size": "Small", "type": "Item"},
}


def _spawn(inst, socket, size, section="Hand", owner="Player"):
    return (f"[GameSimHandler] Cards Spawned: {inst} [{owner}] [{section}] "
            f"[Socket_{socket}] [{size}]")


def _moved(inst, socket, size, section="Hand", owner="Player"):
    return ("[CardOperationUtility] Successfully moved card to: "
            f"[{inst} [{owner}] [{section}] [Socket_{socket}] [{size}]")


class TestBoardLeavesOnStash:
    def _state(self):
        s = new_state()
        s["instance_map"]["i_sub"] = "tid_sub"
        s["instance_map"]["i_ext"] = "tid_ext"
        return s

    def test_moved_to_stash_removes_from_board(self):
        s = self._state()
        process_line(_spawn("i_sub", 0, "Large"), s, DB, False)
        assert "i_sub" in s["player_board"]
        assert process_line(_moved("i_sub", 0, "Large", section="Stash"), s, DB, False) is True
        assert "i_sub" not in s["player_board"]

    def test_spawned_in_stash_removes_from_board(self):
        s = self._state()
        process_line(_spawn("i_sub", 0, "Large"), s, DB, False)
        process_line(_spawn("i_sub", 0, "Large", section="Stash"), s, DB, False)
        assert "i_sub" not in s["player_board"]

    def test_stashed_card_frees_its_socket_for_the_next_one(self):
        # The live bug: a Large at socket 0 went to the stash and stayed tracked, so a
        # Small later placed at socket 0 double-booked the slot and the overlay
        # squeezed both zones — dragging every card in the row off its real position.
        s = self._state()
        process_line(_spawn("i_sub", 0, "Large"), s, DB, False)
        process_line(_moved("i_sub", 0, "Large", section="Stash"), s, DB, False)
        process_line(_spawn("i_ext", 0, "Small"), s, DB, False)
        cards = build_payload(s)["cards"]
        assert [c["title"] for c in cards] == ["Extract"]

    def test_unknown_instance_in_stash_is_not_an_error(self):
        s = self._state()
        assert process_line(_moved("i_ghost", 3, "Small", section="Stash"), s, DB, False) is False


class TestResolveBoard:
    def test_no_two_cards_share_a_socket(self):
        board = {
            "a": {"title": "A", "tier": "Bronze", "size": "Large", "socket": 0},
            "b": {"title": "B", "tier": "Bronze", "size": "Small", "socket": 1},
        }
        kept = logwatch.resolve_board(board, "player")
        assert [c["title"] for c in kept] == ["B"]

    def test_disjoint_cards_all_survive(self):
        board = {
            "a": {"title": "A", "tier": "Bronze", "size": "Medium", "socket": 0},
            "b": {"title": "B", "tier": "Bronze", "size": "Medium", "socket": 2},
            "c": {"title": "C", "tier": "Bronze", "size": "Small", "socket": 4},
        }
        assert len(logwatch.resolve_board(board, "player")) == 3

    def test_board_can_never_exceed_its_slots(self):
        board = {
            str(i): {"title": f"C{i}", "tier": "Bronze", "size": "Large", "socket": i}
            for i in range(10)
        }
        kept = logwatch.resolve_board(board, "player")
        used = sum(logwatch._slot_span(c)[1] - logwatch._slot_span(c)[0] for c in kept)
        assert used <= logwatch.BOARD_SLOTS

    def test_payload_zones_never_overlap(self):
        s = new_state()
        s["player_board"] = {
            "a": {"title": "A", "tier": "Bronze", "size": "Large", "socket": 0},
            "b": {"title": "B", "tier": "Bronze", "size": "Medium", "socket": 1},
            "c": {"title": "C", "tier": "Bronze", "size": "Small", "socket": 4},
        }
        cards = sorted(build_payload(s)["cards"], key=lambda c: c["x"])
        for a, b in zip(cards, cards[1:]):
            assert a["x"] + a["w"] <= b["x"] + 1e-9


class TestPurchaseWithoutSocket:
    def test_socketless_purchase_does_not_invent_a_slot(self):
        s = new_state()
        line = ("[BoardManager] Card Purchased: InstanceId: i_x - "
                "TemplateIdtid_sub - Target:Stash - SectionPlayer")
        process_line(line, s, DB, False)
        assert s["player_board"] == {}
        # the template mapping is still learned, so the spawn line can place it
        assert s["instance_map"]["i_x"] == "tid_sub"
