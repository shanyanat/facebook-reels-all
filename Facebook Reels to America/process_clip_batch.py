from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Clip:
    seq: int
    url: str
    status: str = ""
    topic: str = ""


def default_download_root() -> Path:
    project_dir = Path(__file__).resolve().parent
    return project_dir.with_name(project_dir.name + " download clip")


def find_batch_file(root: Path) -> Path:
    preferred = [root / "url_clip.txt", root / "clip_batch.txt.txt", root / "clip_batch.txt"]
    for path in preferred:
        if path.exists():
            return path

    candidates = [
        p
        for p in root.glob("*.txt")
        if "template" not in p.name.lower() and p.is_file()
    ]
    if not candidates:
        raise FileNotFoundError(f"No batch .txt file found in: {root}")
    return sorted(candidates, key=lambda p: p.stat().st_mtime, reverse=True)[0]


def parse_batch(path: Path) -> tuple[str, list[Clip]]:
    text = path.read_text(encoding="utf-8-sig")
    channel_match = re.search(r"^Channel Name:\s*(.+?)\s*$", text, re.MULTILINE)
    if not channel_match:
        raise ValueError("Missing line like: Channel Name: 1-page-Strange-Frontiers")
    channel = channel_match.group(1).strip()

    clips: list[Clip] = []
    current: dict[str, str] = {}
    current_seq: int | None = None

    for raw_line in text.splitlines():
        line = raw_line.strip()
        seq_match = re.match(r"^(\d+)\.\s*$", line)
        if seq_match:
            if current_seq is not None and current.get("url"):
                clips.append(
                    Clip(
                        seq=current_seq,
                        url=current["url"],
                        status=current.get("status", ""),
                        topic=current.get("topic", ""),
                    )
                )
            current_seq = int(seq_match.group(1))
            current = {}
            continue

        for key in ("URL", "Status", "Topic"):
            if line.startswith(key + ":"):
                current[key.lower()] = line.split(":", 1)[1].strip()
                break

    if current_seq is not None and current.get("url"):
        clips.append(
            Clip(
                seq=current_seq,
                url=current["url"],
                status=current.get("status", ""),
                topic=current.get("topic", ""),
            )
        )

    if not clips:
        raise ValueError("No URL lines found. Add lines like: URL: https://...")
    return channel, clips


def write_batch(path: Path, channel: str, clips: list[Clip]) -> None:
    lines = [f"Channel Name: {channel}", ""]
    for clip in clips:
        lines.extend(
            [
                f"{clip.seq}.",
                f"URL: {clip.url}",
                f"Status: {clip.status}",
                f"Topic: {clip.topic}",
                "",
            ]
        )
    path.write_text("\n".join(lines), encoding="utf-8")


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=check,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


def ensure_tooling() -> None:
    try:
        run([sys.executable, "-m", "yt_dlp", "--version"])
    except (subprocess.CalledProcessError, FileNotFoundError):
        raise RuntimeError(
            "yt-dlp is not installed for this Python. Run: py -m pip install -U yt-dlp"
        )


def download_clip(clip: Clip, channel_dir: Path) -> bool:
    seq = f"{clip.seq:02d}"
    output_template = str(channel_dir / f"{seq}-%(id)s.%(ext)s")
    command = [
        sys.executable,
        "-m",
        "yt_dlp",
        "--no-playlist",
        "--windows-filenames",
        "--merge-output-format",
        "mp4",
        "-o",
        output_template,
        clip.url,
    ]

    print(f"Downloading #{clip.seq}: {clip.url}")
    result = run(command, check=False)
    if result.returncode != 0:
        print(result.stdout)
        return False
    return True


def create_contact_sheets(channel_dir: Path) -> None:
    try:
        run(["ffmpeg", "-version"])
    except (subprocess.CalledProcessError, FileNotFoundError):
        print("ffmpeg not found, skipping frame/contact-sheet extraction.")
        return

    frames_dir = channel_dir / "_frames"
    frames_dir.mkdir(exist_ok=True)

    for video in sorted(channel_dir.glob("*.mp4")):
        stem = video.stem
        frame_pattern = str(frames_dir / f"{stem}-frame-%02d.jpg")
        sheet_path = str(frames_dir / f"{stem}-sheet.jpg")

        run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(video),
                "-vf",
                "fps=1/3,scale=540:-1",
                "-frames:v",
                "6",
                frame_pattern,
            ],
            check=False,
        )
        run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-framerate",
                "1",
                "-i",
                frame_pattern,
                "-vf",
                "scale=270:-1,tile=3x2:padding=8:margin=8:color=white",
                "-frames:v",
                "1",
                "-update",
                "1",
                sheet_path,
            ],
            check=False,
        )


def cleanup_auxiliary_files(channel_dir: Path) -> None:
    for info_file in channel_dir.glob("*.info.json"):
        info_file.unlink(missing_ok=True)

    frames_dir = channel_dir / "_frames"
    if frames_dir.exists():
        shutil.rmtree(frames_dir)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Download an Instagram/Reels clip batch and update the batch text file."
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=default_download_root(),
        help="Download root folder. Defaults to the sibling '... download clip' folder.",
    )
    parser.add_argument(
        "--batch",
        type=Path,
        default=None,
        help="Batch .txt file. Defaults to url_clip.txt, then older clip_batch names.",
    )
    parser.add_argument(
        "--keep-analysis-files",
        action="store_true",
        help="Keep helper frame sheets in _frames. Normal output is MP4 files only.",
    )
    args = parser.parse_args()

    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    batch_path = args.batch.resolve() if args.batch else find_batch_file(root)

    channel, clips = parse_batch(batch_path)
    channel_dir = root / channel
    channel_dir.mkdir(parents=True, exist_ok=True)

    ensure_tooling()

    success_count = 0
    for clip in clips:
        if clip.status.lower() == "downloaded":
            print(f"Skipping #{clip.seq}: already marked Downloaded")
            continue

        if download_clip(clip, channel_dir):
            clip.status = "Downloaded"
            success_count += 1
            write_batch(batch_path, channel, clips)
        else:
            clip.status = "Failed"
            write_batch(batch_path, channel, clips)

    if args.keep_analysis_files:
        create_contact_sheets(channel_dir)
    else:
        cleanup_auxiliary_files(channel_dir)

    print("")
    print(f"Batch file: {batch_path}")
    print(f"Channel folder: {channel_dir}")
    print(f"Downloaded this run: {success_count}")
    print("Next Codex step: analyze downloaded clip batch")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Error: {exc}", file=sys.stderr)
        raise SystemExit(1)
