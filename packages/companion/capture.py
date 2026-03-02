"""
capture.py — game window capture using mss (cross-platform)

Returns a numpy BGR array suitable for OpenCV processing.
Falls back to full-screen capture if the game window can't be found.
"""

import sys
import numpy as np

try:
    import mss
    import mss.tools
except ImportError:
    raise ImportError("Install mss: pip install mss")


def _find_window_linux(title: str) -> dict | None:
    """Use xdotool to get window geometry on Linux."""
    import subprocess

    try:
        result = subprocess.run(
            ["xdotool", "search", "--name", title, "getwindowgeometry", "--shell"],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode != 0:
            return None

        # Parse xdotool --shell output: X=, Y=, WIDTH=, HEIGHT=
        geom = {}
        for line in result.stdout.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                geom[k.strip()] = int(v.strip())

        if all(k in geom for k in ("X", "Y", "WIDTH", "HEIGHT")):
            return {
                "left": geom["X"],
                "top": geom["Y"],
                "width": geom["WIDTH"],
                "height": geom["HEIGHT"],
            }
    except (subprocess.TimeoutExpired, FileNotFoundError, ValueError):
        pass

    return None


def _find_window_windows(title: str) -> dict | None:
    """Use win32gui to get window geometry on Windows."""
    try:
        import win32gui

        hwnd = win32gui.FindWindow(None, title)
        if not hwnd:
            # Try partial match
            found = []

            def enum_cb(h, _):
                t = win32gui.GetWindowText(h)
                if title.lower() in t.lower():
                    found.append(h)

            win32gui.EnumWindows(enum_cb, None)
            hwnd = found[0] if found else None

        if hwnd:
            rect = win32gui.GetWindowRect(hwnd)
            left, top, right, bottom = rect
            return {
                "left": left,
                "top": top,
                "width": right - left,
                "height": bottom - top,
            }
    except ImportError:
        pass

    return None


def get_game_window(title: str) -> dict | None:
    """
    Attempt to find the game window geometry by title.
    Returns an mss-compatible monitor dict, or None if not found.
    """
    if sys.platform == "linux":
        return _find_window_linux(title)
    elif sys.platform == "win32":
        return _find_window_windows(title)
    # macOS: fall through to full screen
    return None


def capture_frame(window_title: str = "The Bazaar") -> np.ndarray:
    """
    Capture a frame of the game window (or full screen as fallback).

    Returns:
        numpy array in BGR format (OpenCV convention), shape (H, W, 3)
    """
    with mss.mss() as sct:
        monitor = get_game_window(window_title)

        if monitor is None:
            # Fall back to primary monitor (monitor index 1 in mss)
            monitor = sct.monitors[1]

        # Grab the screen region
        raw = sct.grab(monitor)

        # mss returns BGRA — drop the alpha channel to get BGR
        frame = np.array(raw)[:, :, :3]
        return frame
