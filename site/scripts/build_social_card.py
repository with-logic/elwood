"""Renders the GitHub/Open Graph social card from the landing page's own assets.

The card is 1280x640 (GitHub's recommended size, and a safe 2:1 for Open Graph).
Artwork and typography come from site/assets/landing: the robot, the Anton
wordmark, the Roboto Mono tagline, and the palette in theme.css, so the card
cannot drift from the site it advertises.

Layout is margin-driven rather than hand-placed. The robot and the text block
are measured, then centred together inside a fixed margin box, which is what
keeps the left and right gutters equal. Run:

    python3 site/scripts/build_social_card.py

Requires fonttools[woff] and Pillow (the woff2 web fonts are decompressed to
TTF in a temp dir so Pillow can rasterise them).
"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path

from fontTools.ttLib import TTFont
from PIL import Image, ImageColor, ImageDraw, ImageFont

SITE = Path(__file__).resolve().parents[1]
LANDING = SITE / "assets" / "landing"
FONTS = LANDING / "fonts"

WIDTH, HEIGHT = 1280, 640

# Use the same tokens as both public pages, rather than a second palette.
THEME = (SITE / "theme.css").read_text()


def color(token: str) -> tuple[int, int, int]:
    match = re.search(rf"--{token}:\s*(#[0-9a-fA-F]{{6}});", THEME)
    if match is None:
        raise ValueError(f"Missing theme color: {token}")
    return ImageColor.getrgb(match.group(1))


PAPER = color("paper")
INK = color("ink")
SIGNAL = color("signal")
MUTED = color("muted")

MARGIN = 96  # Equal on all four sides; the whole composition sits inside it.
GAP = 56  # Space between the robot and the rule.
RULE_GAP = 30  # Space between the rule and the text.

TITLE = "Elwood"
TAGLINE = ("Automate real Claude Code and Codex", "sessions in headless PTYs.")


def as_truetype(woff2: Path, out_dir: Path) -> Path:
    """woff2 -> ttf, because Pillow cannot open a compressed web font."""
    font = TTFont(str(woff2))
    ttf = out_dir / f"{woff2.stem}.ttf"
    font.flavor = None
    font.save(str(ttf))
    return ttf


def text_size(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont) -> tuple[int, int]:
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font)
    return right - left, bottom - top


def build_icons() -> None:
    """Render the existing robot bust on the shared brand background."""
    robot = Image.open(LANDING / "robot.webp").convert("RGBA")
    # The antenna, torso and arms stay readable even at favicon sizes.
    bust = robot.crop((0, 0, robot.width, robot.width))
    icon = Image.new("RGB", (512, 512), PAPER)
    bust = bust.resize((448, 448), Image.Resampling.LANCZOS)
    icon.paste(bust, ((512 - bust.width) // 2, (512 - bust.height) // 2), bust)
    icon.save(LANDING / "icon-512.webp", quality=90, method=6)
    icon.resize((180, 180), Image.Resampling.LANCZOS).save(
        LANDING / "apple-touch-icon.png", optimize=True
    )
    icon.save(LANDING / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])


def main() -> None:
    build_icons()
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        anton = ImageFont.truetype(str(as_truetype(FONTS / "anton.woff2", tmp_dir)), 132)
        mono = ImageFont.truetype(str(as_truetype(FONTS / "roboto-mono.woff2", tmp_dir)), 31)

        card = Image.new("RGB", (WIDTH, HEIGHT), PAPER)
        draw = ImageDraw.Draw(card)

        # --- measure the text block -------------------------------------
        title_w, title_h = text_size(draw, TITLE, anton)
        line_h = text_size(draw, TAGLINE[0], mono)[1]
        tag_w = max(text_size(draw, line, mono)[0] for line in TAGLINE)
        leading = int(line_h * 1.62)
        tag_block_h = leading * (len(TAGLINE) - 1) + line_h
        text_w = max(title_w, tag_w)
        text_h = title_h + 34 + tag_block_h

        # --- measure the robot, scaled to the available height ----------
        robot = Image.open(LANDING / "robot.webp").convert("RGBA")
        robot_h = HEIGHT - MARGIN * 2
        robot_w = round(robot.width * robot_h / robot.height)
        robot = robot.resize((robot_w, robot_h), Image.LANCZOS)

        # --- centre robot + rule + text as one composition --------------
        total_w = robot_w + GAP + RULE_GAP + text_w
        x = (WIDTH - total_w) // 2

        card.paste(robot, (x, (HEIGHT - robot_h) // 2), robot)

        rule_x = x + robot_w + GAP
        text_x = rule_x + RULE_GAP
        text_top = (HEIGHT - text_h) // 2

        # Vertical rule with the signal dot, echoing the page's system note.
        # The rule spans the whole text block so it reads as a margin bar
        # rather than stopping short beside the wordmark.
        draw.line(
            [(rule_x, text_top + 8), (rule_x, text_top + text_h)],
            fill=MUTED,
            width=2,
        )
        draw.ellipse([rule_x - 6, text_top - 6, rule_x + 6, text_top + 6], fill=SIGNAL)

        draw.text((text_x, text_top), TITLE, font=anton, fill=INK, anchor="lt")
        y = text_top + title_h + 34
        for line in TAGLINE:
            draw.text((text_x, y), line, font=mono, fill=MUTED, anchor="lt")
            y += leading

        png = LANDING / "social-card.png"
        card.save(png, optimize=True)
        card.save(LANDING / "social-card.webp", quality=90, method=6)
        print(f"wrote {png.relative_to(SITE)} ({png.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
