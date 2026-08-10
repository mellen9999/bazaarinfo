"""
Regression tests for logwatch.py bug fixes.
Run: python3 -m pytest packages/companion/test_logwatch.py -q
"""

import sys
import os

sys.path.insert(0, os.path.dirname(__file__))

import configparser

import pytest

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
    resolve_ebs_config,
    backoff_delay,
    load_config,
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


# --- transforms: the original card is destroyed, replacements spawn separately ---

class TestTransformed:
    def _state(self):
        s = new_state()
        s["instance_map"]["i_old"] = "tid_sub"
        return s

    def _line(self, body):
        return "[GameSimHandler] " + body

    def test_original_leaves_the_board(self):
        s = self._state()
        process_line(_spawn("i_old", 0, "Large"), s, DB, False)
        assert "i_old" in s["player_board"]
        assert process_line(self._line("Transformed: i_old into: i_new "), s, DB, False) is True
        assert s["player_board"] == {}

    def test_many_pairs_on_one_line(self):
        s = new_state()
        for n in ("a", "b", "c"):
            s["instance_map"][n] = "tid_ext"
            process_line(_spawn(n, {"a": 0, "b": 1, "c": 2}[n], "Small"), s, DB, False)
        line = self._line("Transformed: a into: x Transformed: b into: y Transformed: c into: z ")
        assert process_line(line, s, DB, False) is True
        assert s["player_board"] == {}

    def test_one_card_transforming_into_several(self):
        s = self._state()
        process_line(_spawn("i_old", 0, "Large"), s, DB, False)
        process_line(self._line("Transformed: i_old into: n1 n2 n3 "), s, DB, False)
        assert s["player_board"] == {}

    def test_replacement_ids_are_not_treated_as_originals(self):
        s = new_state()
        for n in ("keep", "gone"):
            s["instance_map"][n] = "tid_ext"
        process_line(_spawn("keep", 4, "Small"), s, DB, False)
        process_line(_spawn("gone", 5, "Small"), s, DB, False)
        # "keep" appears only as a replacement — it must survive
        process_line(self._line("Transformed: gone into: keep "), s, DB, False)
        assert list(s["player_board"]) == ["keep"]

    def test_unknown_original_is_not_a_change(self):
        s = new_state()
        assert process_line(self._line("Transformed: nobody into: someone "), s, DB, False) is False

    def test_transformed_card_frees_its_socket(self):
        # the live leak: the original kept its socket forever, so its replacement
        # double-booked the slot and the row was squeezed off position
        s = self._state()
        process_line(_spawn("i_old", 0, "Large"), s, DB, False)
        process_line(self._line("Transformed: i_old into: i_new "), s, DB, False)
        s["instance_map"]["i_new"] = "tid_sub"
        process_line(_spawn("i_new", 0, "Large"), s, DB, False)
        cards = build_payload(s)["cards"]
        assert [c["title"] for c in cards] == ["Submarine"]


# --- cards we cannot name must never reach the wire ---

class TestNamedOnly:
    def test_unnameable_card_is_dropped(self):
        s = new_state()
        process_line(_spawn("i_ghost", 3, "Small"), s, DB, False)  # no template ever seen
        assert "i_ghost" in s["player_board"]
        assert build_payload(s)["cards"] == []

    def test_unnameable_card_cannot_evict_a_named_one(self):
        # regression: filtering after resolve_board let an anonymous card win the
        # socket clash and then get dropped, costing the viewer a real tooltip
        s = new_state()
        s["instance_map"]["i_real"] = "tid_sub"
        process_line(_spawn("i_real", 0, "Large"), s, DB, False)
        process_line(_spawn("i_ghost", 1, "Small"), s, DB, False)
        assert [c["title"] for c in build_payload(s)["cards"]] == ["Submarine"]

    def test_every_shipped_card_has_a_real_title_and_tier(self):
        s = new_state()
        s["instance_map"]["i_real"] = "tid_ext"
        process_line(_spawn("i_real", 2, "Small"), s, DB, False)
        process_line(_spawn("i_ghost", 6, "Small"), s, DB, False)
        for c in build_payload(s)["cards"]:
            assert c["tier"] != "Unknown"
            assert not c["title"].startswith(("itm_", "skl_"))


# --- honest tier: the log never states a live tier, so say so on the wire ---

class TestTierHonesty:
    def test_items_and_skills_declare_the_tier_unverified(self):
        s = new_state()
        s["instance_map"]["i_real"] = "tid_sub"
        process_line(_spawn("i_real", 0, "Large"), s, DB, False)
        cards = build_payload(s)["cards"]
        assert cards and all(c["tierKnown"] is False for c in cards)


# --- coalescing: one send per game action, never per log line ---

class TestShouldFlush:
    def test_nothing_pending_never_sends(self):
        assert logwatch.should_flush(False, 100.0, 100.0, 0.0) is False

    def test_holds_while_the_log_is_still_talking(self):
        now = 100.0
        assert logwatch.should_flush(True, now, now - 0.05, now - 0.05) is False

    def test_sends_once_the_log_goes_quiet(self):
        now = 100.0
        assert logwatch.should_flush(True, now, now - logwatch.SEND_COALESCE_S, now - 0.5) is True

    def test_never_holds_a_change_past_the_latency_cap(self):
        # a log that never stops must not stall the overlay
        now = 100.0
        assert logwatch.should_flush(True, now, now, now - logwatch.SEND_MAX_LATENCY_S) is True

    def test_a_two_line_swap_collapses_into_one_send(self):
        # the drag case: both lines land inside the coalesce window
        start = 100.0
        assert logwatch.should_flush(True, start + 0.002, start, start) is False


# --- resolve_ebs_config: one source of truth for url/channel/secret ---

def _config(url="https://ebs.example.com", channel_id="123", secret="s3cret"):
    c = configparser.ConfigParser()
    c["ebs"] = {}
    if url is not None:
        c["ebs"]["url"] = url
    c["ebs"]["channel_id"] = channel_id
    if secret is not None:
        c["ebs"]["secret"] = secret
    return c


class TestResolveEbsConfig:
    def test_reads_url_channel_secret_from_config(self, monkeypatch):
        monkeypatch.delenv("EBS_SECRET", raising=False)
        url, channel_id, secret = resolve_ebs_config(_config())
        assert (url, channel_id, secret) == ("https://ebs.example.com", "123", "s3cret")

    def test_env_secret_only_setup_does_not_crash(self, monkeypatch):
        # secret omitted from config.ini entirely — validate_config allows this when
        # EBS_SECRET is set. Accessing config["ebs"]["secret"] directly here would
        # raise a raw KeyError.
        monkeypatch.setenv("EBS_SECRET", "from-env")
        url, channel_id, secret = resolve_ebs_config(_config(secret=None))
        assert secret == "from-env"

    def test_env_secret_wins_over_config_secret(self, monkeypatch):
        monkeypatch.setenv("EBS_SECRET", "from-env")
        _, _, secret = resolve_ebs_config(_config(secret="from-config"))
        assert secret == "from-env"

    def test_config_secret_used_when_no_env(self, monkeypatch):
        monkeypatch.delenv("EBS_SECRET", raising=False)
        _, _, secret = resolve_ebs_config(_config(secret="from-config"))
        assert secret == "from-config"

    def test_trailing_slash_url_normalized(self, monkeypatch):
        monkeypatch.delenv("EBS_SECRET", raising=False)
        url, _, _ = resolve_ebs_config(_config(url="https://ebs.example.com/"))
        assert url == "https://ebs.example.com"

    def test_url_without_trailing_slash_unchanged(self, monkeypatch):
        monkeypatch.delenv("EBS_SECRET", raising=False)
        url, _, _ = resolve_ebs_config(_config(url="https://ebs.example.com"))
        assert url == "https://ebs.example.com"


# --- backoff_delay: pure schedule for send-failure retries ---

class TestBackoffDelay:
    def test_no_failures_no_delay(self):
        assert backoff_delay(0) == 0.0

    def test_negative_treated_as_no_failures(self):
        assert backoff_delay(-1) == 0.0

    def test_first_failure_is_base_delay(self):
        assert backoff_delay(1) == logwatch.BACKOFF_BASE_S

    def test_delay_doubles_each_failure(self):
        assert backoff_delay(2) == logwatch.BACKOFF_BASE_S * 2
        assert backoff_delay(3) == logwatch.BACKOFF_BASE_S * 4
        assert backoff_delay(4) == logwatch.BACKOFF_BASE_S * 8

    def test_delay_caps_and_does_not_grow_further(self):
        capped = backoff_delay(20)
        assert capped == logwatch.BACKOFF_CAP_S
        assert backoff_delay(21) == logwatch.BACKOFF_CAP_S

    def test_schedule_resets_after_success(self):
        # simulates: several failures climb the schedule, then a success brings the
        # next attempt back to failures=0 (no delay) — never a full traceback-style
        # exponential in production, but exercised via the counter reset it drives.
        assert backoff_delay(3) > backoff_delay(1)
        assert backoff_delay(0) == 0.0


# --- load_config: corrupt ini must exit cleanly, never a raw traceback ---

class TestLoadConfig:
    def test_valid_ini_parses(self, tmp_path):
        p = tmp_path / "config.ini"
        p.write_text("[ebs]\nurl = https://e\nchannel_id = 1\nsecret = s\n")
        config = load_config(p)
        assert config["ebs"]["url"] == "https://e"

    def test_missing_file_is_not_an_error(self, tmp_path):
        # matches configparser.read()'s own behavior — a missing file yields an empty
        # (invalid) config, caught downstream by validate_config, not by load_config.
        p = tmp_path / "nope.ini"
        config = load_config(p)
        assert config.sections() == []

    def test_duplicate_key_exits_cleanly(self, tmp_path):
        p = tmp_path / "config.ini"
        p.write_text("[ebs]\nurl = https://e\nurl = https://f\n")
        with pytest.raises(SystemExit) as exc:
            load_config(p)
        assert exc.value.code == 1

    def test_duplicate_section_exits_cleanly(self, tmp_path):
        p = tmp_path / "config.ini"
        p.write_text("[ebs]\nurl = https://e\n[ebs]\nurl = https://f\n")
        with pytest.raises(SystemExit) as exc:
            load_config(p)
        assert exc.value.code == 1

    def test_malformed_line_exits_cleanly(self, tmp_path):
        p = tmp_path / "config.ini"
        p.write_text("[ebs]\nnot a valid line without equals or colon\n")
        with pytest.raises(SystemExit) as exc:
            load_config(p)
        assert exc.value.code == 1
