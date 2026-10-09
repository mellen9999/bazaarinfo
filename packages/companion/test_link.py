"""One-click setup: twitch device-code sign-in traded for the channel's secret."""

import pytest

import logwatch
from logwatch import LinkError, link_with_twitch


class R:
    def __init__(self, code, body=None):
        self.status_code = code
        self.ok = code < 400
        self._body = body

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


DEVICE = R(200, {"device_code": "dc", "user_code": "ABCD-EFGH", "interval": 5,
                 "expires_in": 1800, "verification_uri": "https://www.twitch.tv/activate?device-code=ABCDEFGH"})
PENDING = R(400, {"status": 400, "message": "authorization_pending"})
TOKEN = R(200, {"access_token": "tok"})
LINKED = R(200, {"channelId": "12345", "login": "streamer", "secret": "s3cret"})


def script(monkeypatch, *replies):
    """_session.post returns replies in order; records (url, kwargs)."""
    calls, queue = [], list(replies)

    def post(url, **kw):
        calls.append((url, kw))
        r = queue.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    monkeypatch.setattr(logwatch._session, "post", post)
    return calls


class Clock:
    def __init__(self):
        self.t = 0.0

    def now(self):
        return self.t

    def sleep(self, s):
        self.t += s


def run(clock=None, opened=None):
    clock = clock or Clock()
    return link_with_twitch("https://ebs", open_browser=(opened.append if opened is not None else lambda u: None),
                            sleep=clock.sleep, now=clock.now)


def test_happy_path_opens_twitch_and_returns_credentials(monkeypatch, capsys):
    opened = []
    calls = script(monkeypatch, DEVICE, PENDING, PENDING, TOKEN, LINKED)
    assert run(opened=opened) == ("12345", "s3cret")
    assert opened == ["https://www.twitch.tv/activate?device-code=ABCDEFGH"]
    assert calls[-1][0] == "https://ebs/companion/link"
    assert calls[-1][1]["json"] == {"token": "tok"}
    out = capsys.readouterr().out
    assert "ABCD-EFGH" in out and "streamer" in out
    assert "tok" not in out and "s3cret" not in out  # never echo credentials


def test_slow_down_backs_off(monkeypatch):
    clock = Clock()
    script(monkeypatch, DEVICE, R(400, {"message": "slow_down"}), TOKEN, LINKED)
    run(clock=clock)
    assert clock.t == 5 + 10


def test_wifi_blip_while_waiting_keeps_polling(monkeypatch):
    script(monkeypatch, DEVICE, OSError("wifi"), TOKEN, LINKED)
    assert run() == ("12345", "s3cret")


def test_expired_code_fails_with_plain_message(monkeypatch):
    script(monkeypatch, DEVICE, R(400, {"message": "invalid device code"}))
    with pytest.raises(LinkError, match="expired"):
        run()


def test_gives_up_at_the_deadline(monkeypatch):
    short = R(200, {**DEVICE._body, "expires_in": 12})
    script(monkeypatch, short, PENDING, PENDING, PENDING, PENDING)
    with pytest.raises(LinkError, match="expired"):
        run()


def test_twitch_unreachable(monkeypatch):
    script(monkeypatch, OSError("dns"))
    with pytest.raises(LinkError, match="reach twitch"):
        run()


def test_server_rejection_surfaces_its_reason(monkeypatch):
    script(monkeypatch, DEVICE, TOKEN, R(403, {"error": "wrong app"}))
    with pytest.raises(LinkError, match="wrong app"):
        run()


def test_garbage_from_server_is_refused(monkeypatch):
    script(monkeypatch, DEVICE, TOKEN, R(200, {"channelId": "x", "secret": ""}))
    with pytest.raises(LinkError):
        run()


def test_setup_falls_back_to_pasting_when_sign_in_fails(monkeypatch, tmp_path):
    monkeypatch.setattr(logwatch, "link_with_twitch", lambda url: (_ for _ in ()).throw(LinkError("nope")))
    answers = iter(["777", "pasted"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(answers))
    cfg = tmp_path / "config.ini"
    logwatch.setup_config(cfg)
    c = logwatch.load_config(cfg)
    assert c["ebs"]["channel_id"] == "777" and c["ebs"]["secret"] == "pasted"


def test_setup_writes_linked_credentials(monkeypatch, tmp_path):
    monkeypatch.setattr(logwatch, "link_with_twitch", lambda url: ("12345", "s3cret"))
    cfg = tmp_path / "config.ini"
    logwatch.setup_config(cfg)
    c = logwatch.load_config(cfg)
    assert c["ebs"]["url"] == logwatch.DEFAULT_EBS_URL
    assert (c["ebs"]["channel_id"], c["ebs"]["secret"]) == ("12345", "s3cret")
