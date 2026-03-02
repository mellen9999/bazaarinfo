"""
matcher.py — FLANN-based card identification using precomputed SIFT features

Load once at startup, then call match_cards() per frame.
"""

import numpy as np
import cv2
from pathlib import Path
from dataclasses import dataclass

FEATURES_PATH = Path(__file__).parent / "features" / "features.npz"


@dataclass
class CardMatch:
    title: str
    tier: str
    # Normalized coordinates (0.0–1.0) relative to full frame
    x: float
    y: float
    w: float
    h: float


class CardMatcher:
    def __init__(
        self,
        features_path: Path = FEATURES_PATH,
        ratio_threshold: float = 0.7,
        min_good_matches: int = 15,
    ):
        self.ratio_threshold = ratio_threshold
        self.min_good_matches = min_good_matches
        self._load_features(features_path)
        self._build_flann()

    def _load_features(self, path: Path):
        """Load precomputed SIFT descriptors and card metadata from .npz file."""
        if not path.exists():
            raise FileNotFoundError(
                f"Features file not found: {path}\n"
                "Run features/extract.py first to generate it."
            )

        # allow_pickle=True is required for loading object arrays (title/tier strings).
        # The features.npz is generated locally by extract.py — trust it the same way
        # you trust any local config file.
        data = np.load(path, allow_pickle=True)
        # descriptors: (N_cards, N_keypoints, 128) float32
        self.descriptors = data["descriptors"]
        self.titles = list(data["titles"])
        self.tiers = list(data["tiers"])

        # Flatten to (N_cards * N_keypoints, 128) for FLANN
        # Keep track of which card each descriptor row belongs to
        n_cards, n_kp, desc_dim = self.descriptors.shape
        self._flat_descriptors = self.descriptors.reshape(-1, desc_dim).astype(np.float32)
        self._card_for_row = np.repeat(np.arange(n_cards), n_kp)
        self._n_kp_per_card = n_kp

        print(f"[matcher] Loaded {n_cards} cards x {n_kp} keypoints")

    def _build_flann(self):
        """Build FLANN KD-Tree index over the flat descriptor matrix."""
        index_params = dict(algorithm=1, trees=5)  # algorithm=1 -> FLANN_INDEX_KDTREE
        search_params = dict(checks=50)
        self.flann = cv2.FlannBasedMatcher(index_params, search_params)
        # Train on the full descriptor bank
        self.flann.add([self._flat_descriptors])
        self.flann.train()

    def _extract_sift(self, region: np.ndarray):
        """
        Extract SIFT descriptors from a card region.

        Args:
            region: BGR numpy array of the card crop

        Returns:
            descriptors array (N, 128) float32, or None if not enough keypoints
        """
        gray = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)
        gray = cv2.resize(gray, (200, 200))

        sift = cv2.SIFT_create()
        _, descriptors = sift.detectAndCompute(gray, None)
        return descriptors  # None if no keypoints found

    def _vote_for_card(self, good_matches: list) -> dict:
        """Count good matches per card index."""
        votes = {}
        for m in good_matches:
            # m.trainIdx is the row in the flat descriptor matrix
            card_idx = int(self._card_for_row[m.trainIdx])
            votes[card_idx] = votes.get(card_idx, 0) + 1
        return votes

    def match_region(self, region: np.ndarray):
        """
        Identify a single card region.

        Returns:
            (title, tier) if confident match found, else None
        """
        descriptors = self._extract_sift(region)
        if descriptors is None or len(descriptors) < 2:
            return None

        query = descriptors.astype(np.float32)

        # knnMatch: for each query descriptor, find 2 nearest in the bank
        matches = self.flann.knnMatch(query, k=2)

        # Lowe's ratio test
        good = []
        for pair in matches:
            if len(pair) == 2:
                m, n = pair
                if m.distance < self.ratio_threshold * n.distance:
                    good.append(m)

        if len(good) < self.min_good_matches:
            return None

        votes = self._vote_for_card(good)
        if not votes:
            return None

        best_idx = max(votes, key=votes.__getitem__)
        if votes[best_idx] < self.min_good_matches:
            return None

        return self.titles[best_idx], self.tiers[best_idx]

    def match_cards(self, frame: np.ndarray, regions: list) -> list:
        """
        Identify cards in a list of bounding-box regions.

        Args:
            frame: full BGR frame (used for coordinate normalization)
            regions: list of dicts with keys x, y, w, h (pixel coords)

        Returns:
            list of CardMatch with normalized coordinates
        """
        h_frame, w_frame = frame.shape[:2]
        results = []
        seen_titles = set()

        for region_info in regions:
            rx, ry, rw, rh = (
                region_info["x"],
                region_info["y"],
                region_info["w"],
                region_info["h"],
            )

            # Crop the region from the frame
            crop = frame[ry : ry + rh, rx : rx + rw]
            if crop.size == 0:
                continue

            match = self.match_region(crop)
            if match is None:
                continue

            title, tier = match

            # Deduplicate — same card shouldn't appear twice
            if title in seen_titles:
                continue
            seen_titles.add(title)

            results.append(
                CardMatch(
                    title=title,
                    tier=tier,
                    x=rx / w_frame,
                    y=ry / h_frame,
                    w=rw / w_frame,
                    h=rh / h_frame,
                )
            )

        return results
