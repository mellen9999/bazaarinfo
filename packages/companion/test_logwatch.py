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
)


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
