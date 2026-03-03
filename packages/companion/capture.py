"""
capture.py — game window capture via grim (Wayland) or mss (X11/Windows)

Returns a numpy BGR array suitable for OpenCV processing.
"""

import subprocess
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np


def _capture_grim() -> np.ndarray:
    """Capture full screen using grim (Wayland)."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        tmp = f.name
    try:
        subprocess.run(["grim", tmp], check=True, capture_output=True, timeout=5)
        img = cv2.imread(tmp)
        if img is None:
            raise RuntimeError("grim captured empty image")
        return img
    finally:
        Path(tmp).unlink(missing_ok=True)


def capture_frame(window_title: str = "The Bazaar") -> np.ndarray:
    """
    Capture the screen. Uses grim on Wayland, falls back to mss on X11.

    Returns:
        numpy array in BGR format (OpenCV convention), shape (H, W, 3)
    """
    session_type = __import__("os").environ.get("XDG_SESSION_TYPE", "")

    if session_type == "wayland":
        return _capture_grim()

    # X11 / Windows fallback via mss
    import mss
    with mss.mss() as sct:
        raw = sct.grab(sct.monitors[1])
        return np.array(raw)[:, :, :3]
