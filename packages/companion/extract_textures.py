"""
extract_textures.py — Extract card art from Unity asset bundles

Pulls 1024x1024 diffuse textures (_D suffix) from The Bazaar's
addressable asset bundles. Outputs PNG files for SIFT feature extraction.

Usage:
    python extract_textures.py [--game-dir /path/to/TheBazaar] [--output ./card_images]
"""

import argparse
import sys
from pathlib import Path

import UnityPy

UnityPy.config.FALLBACK_UNITY_VERSION = "6000.0.58f2"

GAME_DIR_DEFAULT = Path.home() / ".local/share/Steam/steamapps/common/The Bazaar"
BUNDLES_REL = "TheBazaar_Data/StreamingAssets/aa/StandaloneWindows64"


def extract(game_dir: Path, output_dir: Path):
    bundles_dir = game_dir / BUNDLES_REL
    if not bundles_dir.is_dir():
        print(f"Bundles dir not found: {bundles_dir}", file=sys.stderr)
        sys.exit(1)

    output_dir.mkdir(parents=True, exist_ok=True)

    # Only process card-related bundles
    bundle_files = sorted(bundles_dir.glob("card_*__*.bundle"))
    print(f"Found {len(bundle_files)} card bundles")

    total = 0
    for i, bf in enumerate(bundle_files, 1):
        print(f"  [{i}/{len(bundle_files)}] {bf.name}", end="\r", flush=True)
        try:
            env = UnityPy.load(str(bf))
        except Exception as e:
            print(f"\n  [warn] Failed to load {bf.name}: {e}", file=sys.stderr)
            continue

        for obj in env.objects:
            if obj.type.name != "Texture2D":
                continue
            data = obj.read()
            name = data.m_Name

            # Only diffuse textures, skip masks/flowmaps/fx
            if not name.endswith("_D"):
                continue
            if data.m_Width < 256:
                continue

            img = data.image
            out_path = output_dir / f"{name}.png"
            img.save(str(out_path))
            total += 1

    print(f"\nExtracted {total} card textures to {output_dir}")


def main():
    parser = argparse.ArgumentParser(description="Extract card art from Unity bundles")
    parser.add_argument("--game-dir", type=Path, default=GAME_DIR_DEFAULT)
    parser.add_argument("--output", type=Path, default=Path(__file__).parent / "card_images")
    args = parser.parse_args()
    extract(args.game_dir, args.output)


if __name__ == "__main__":
    main()
