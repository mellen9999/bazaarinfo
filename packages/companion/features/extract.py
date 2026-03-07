"""
features/extract.py — One-time script to precompute SIFT features from card images

Run this once after downloading card images. Output: features/features.npz
This file is loaded at startup by matcher.py for fast in-memory FLANN matching.

Usage:
    python features/extract.py --images /path/to/card/images/

Expected image structure:
    card_images/
        CF_M_ADV_Scythe_D.png
        CF_L_DOO_3DPrinter_D.png
        ...

Filename parsing: card title extracted from Unity texture naming convention.
"""

import argparse
import sys
import re
from pathlib import Path

import numpy as np
import cv2

OUTPUT_PATH = Path(__file__).parent / "features.npz"
RESIZE_TO = (200, 200)
# SIFT is nondeterministic in keypoint count — pad/clip to a fixed size
N_KEYPOINTS = 500


def parse_title_from_path(image_path: Path) -> str:
    """
    Extract card title from Unity texture filename.
    Format: CF_{Size}_{Hero}_{CardName}_D.png
    e.g. CF_M_ADV_Scythe_D.png -> "Scythe"
         CF_L_DOO_3DPrinter_D.png -> "3D Printer"
    """
    stem = image_path.stem

    # Strip trailing _D (diffuse suffix)
    if stem.endswith("_D"):
        stem = stem[:-2]

    # Strip CF_{Size}_{Hero}_ prefix
    parts = stem.split("_")
    if len(parts) >= 4 and parts[0] == "CF":
        name_part = "".join(parts[3:])
    else:
        name_part = stem

    # CamelCase to spaced: "EyeOfTheColossus" -> "Eye Of The Colossus"
    title = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", name_part)
    return title


def extract_sift_descriptors(image_path: Path) -> np.ndarray | None:
    """
    Load image, resize to 200x200, extract SIFT descriptors.
    Returns a (N_KEYPOINTS, 128) float32 array padded/clipped to N_KEYPOINTS.
    Returns None if the image can't be loaded or has no keypoints.
    """
    img = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
    if img is None:
        print(f"  [warn] Cannot read image: {image_path}", file=sys.stderr)
        return None

    img = cv2.resize(img, RESIZE_TO)

    sift = cv2.SIFT_create(nfeatures=N_KEYPOINTS)
    _, descriptors = sift.detectAndCompute(img, None)

    if descriptors is None or len(descriptors) == 0:
        print(f"  [warn] No keypoints found: {image_path}", file=sys.stderr)
        return None

    # Pad with zeros or clip to exactly N_KEYPOINTS rows
    n = descriptors.shape[0]
    if n < N_KEYPOINTS:
        pad = np.zeros((N_KEYPOINTS - n, 128), dtype=np.float32)
        descriptors = np.vstack([descriptors, pad])
    elif n > N_KEYPOINTS:
        descriptors = descriptors[:N_KEYPOINTS]

    return descriptors.astype(np.float32)


def main():
    parser = argparse.ArgumentParser(
        description="Precompute SIFT features for Bazaar card images."
    )
    parser.add_argument(
        "--images",
        required=True,
        type=Path,
        help="Directory containing card images (PNG/JPG)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=OUTPUT_PATH,
        help=f"Output .npz path (default: {OUTPUT_PATH})",
    )
    args = parser.parse_args()

    image_dir = args.images
    if not image_dir.is_dir():
        print(f"Error: not a directory: {image_dir}", file=sys.stderr)
        sys.exit(1)

    # Collect all image files recursively
    extensions = {".png", ".jpg", ".jpeg", ".webp"}
    image_paths = sorted(
        p for p in image_dir.rglob("*") if p.suffix.lower() in extensions
    )

    if not image_paths:
        print(f"No images found in {image_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(image_paths)} images in {image_dir}")

    all_descriptors = []
    all_titles = []
    skipped = 0

    for i, path in enumerate(image_paths, 1):
        print(f"  [{i}/{len(image_paths)}] {path.name}", end="\r", flush=True)

        descriptors = extract_sift_descriptors(path)
        if descriptors is None:
            skipped += 1
            continue

        all_descriptors.append(descriptors)
        all_titles.append(parse_title_from_path(path))

    print()  # newline after the \r progress

    if not all_descriptors:
        print("No valid descriptors extracted. Aborting.", file=sys.stderr)
        sys.exit(1)

    n_cards = len(all_descriptors)
    print(f"Extracted features for {n_cards} cards ({skipped} skipped)")

    # Stack into (N_cards, N_KEYPOINTS, 128)
    descriptors_array = np.stack(all_descriptors, axis=0)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez(
        args.output,
        descriptors=descriptors_array,
        titles=np.array(all_titles, dtype=object),
    )

    print(f"Saved to {args.output}")
    print(f"  Shape: {descriptors_array.shape}  ({descriptors_array.nbytes // 1024} KB)")


if __name__ == "__main__":
    main()
