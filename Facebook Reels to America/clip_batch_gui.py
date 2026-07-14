from __future__ import annotations

import queue
import re
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from dataclasses import dataclass
from pathlib import Path
from tkinter import messagebox, ttk

from process_clip_batch import (
    BatchGroup,
    Clip,
    default_download_root,
    parse_batch_groups,
    write_batch_groups,
)


PROJECT_DIR = Path(__file__).resolve().parent
DOWNLOAD_ROOT = default_download_root()
BATCH_FILE_NAME = "url_clip.txt"


INVALID_PATH_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
URL_RE = re.compile(r"https?://[^\s<>\"]+")
WINDOWS_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


@dataclass
class ChannelSummary:
    channel: str
    total: int
    downloaded: int
    failed: int
    pending: int
    folder: Path


def sanitize_channel_name(raw_name: str) -> str:
    name = raw_name.strip()
    if not name:
        raise ValueError("Enter a field/folder name first.")

    name = INVALID_PATH_CHARS.sub("-", name)
    name = re.sub(r"\s+", "-", name)
    name = re.sub(r"-{2,}", "-", name).strip(" .-")
    if not name:
        raise ValueError("The field/folder name contains no usable characters.")

    if name.upper() in WINDOWS_RESERVED_NAMES:
        name = f"{name}-field"

    return name[:120]


def extract_urls(raw_text: str) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    for match in URL_RE.finditer(raw_text):
        url = match.group(0).rstrip(".,;)")
        if url not in seen:
            urls.append(url)
            seen.add(url)
    return urls


def batch_path(root: Path = DOWNLOAD_ROOT) -> Path:
    return root / BATCH_FILE_NAME


def load_groups(root: Path = DOWNLOAD_ROOT) -> list[BatchGroup]:
    path = batch_path(root)
    if not path.exists() or not path.read_text(encoding="utf-8-sig").strip():
        return []
    return parse_batch_groups(path)


def save_groups(groups: list[BatchGroup], root: Path = DOWNLOAD_ROOT) -> None:
    root.mkdir(parents=True, exist_ok=True)
    write_batch_groups(batch_path(root), groups)


def find_group(groups: list[BatchGroup], channel: str) -> BatchGroup | None:
    normalized = channel.casefold()
    return next((group for group in groups if group.channel.casefold() == normalized), None)


def create_channel_folder(channel_name: str, root: Path = DOWNLOAD_ROOT) -> ChannelSummary:
    channel = sanitize_channel_name(channel_name)
    root.mkdir(parents=True, exist_ok=True)
    (root / channel).mkdir(parents=True, exist_ok=True)

    groups = load_groups(root)
    if find_group(groups, channel) is None:
        groups.append(BatchGroup(channel=channel, clips=[]))
        save_groups(groups, root)

    return summarize_channel(find_group(groups, channel) or BatchGroup(channel, []), root)


def add_links_to_channel(channel_name: str, urls_text: str, root: Path = DOWNLOAD_ROOT) -> ChannelSummary:
    channel = sanitize_channel_name(channel_name)
    urls = extract_urls(urls_text)
    if not urls:
        raise ValueError("Paste at least one URL before adding links.")

    root.mkdir(parents=True, exist_ok=True)
    (root / channel).mkdir(parents=True, exist_ok=True)

    groups = load_groups(root)
    group = find_group(groups, channel)
    if group is None:
        group = BatchGroup(channel=channel, clips=[])
        groups.append(group)

    existing_urls = {clip.url for clip in group.clips}
    for url in urls:
        if url not in existing_urls:
            group.clips.append(Clip(seq=len(group.clips) + 1, url=url))
            existing_urls.add(url)

    save_groups(groups, root)
    return summarize_channel(group, root)


def clear_channel(channel_name: str, root: Path = DOWNLOAD_ROOT) -> ChannelSummary:
    channel = sanitize_channel_name(channel_name)
    root.mkdir(parents=True, exist_ok=True)
    (root / channel).mkdir(parents=True, exist_ok=True)

    groups = load_groups(root)
    group = find_group(groups, channel)
    if group is None:
        group = BatchGroup(channel=channel, clips=[])
        groups.append(group)
    else:
        group.clips.clear()

    save_groups(groups, root)
    return summarize_channel(group, root)


def delete_channel(channel_name: str, root: Path = DOWNLOAD_ROOT) -> str:
    channel = sanitize_channel_name(channel_name)
    groups = [group for group in load_groups(root) if group.channel.casefold() != channel.casefold()]
    save_groups(groups, root)

    folder = root / channel
    if folder.exists():
        shutil.rmtree(folder)
    return channel


def summarize_channel(group: BatchGroup, root: Path = DOWNLOAD_ROOT) -> ChannelSummary:
    downloaded = sum(1 for clip in group.clips if clip.status.lower() == "downloaded")
    failed = sum(1 for clip in group.clips if clip.status.lower() == "failed")
    pending = len(group.clips) - downloaded - failed
    return ChannelSummary(
        channel=group.channel,
        total=len(group.clips),
        downloaded=downloaded,
        failed=failed,
        pending=pending,
        folder=root / group.channel,
    )


def summarize_all(root: Path = DOWNLOAD_ROOT) -> list[ChannelSummary]:
    groups = load_groups(root)
    summaries = [summarize_channel(group, root) for group in groups]
    known = {summary.channel.casefold() for summary in summaries}
    if root.exists():
        for folder in sorted(path for path in root.iterdir() if path.is_dir()):
            if folder.name.casefold() not in known:
                summaries.append(ChannelSummary(folder.name, 0, 0, 0, 0, folder))
    return sorted(summaries, key=lambda item: item.channel.casefold())


class ClipBatchApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Clip Batch Control")
        self.minsize(940, 620)

        self.output_queue: queue.Queue[str] = queue.Queue()
        self.process: subprocess.Popen[str] | None = None
        self.running_thread: threading.Thread | None = None

        self.channel_var = tk.StringVar()
        self.status_var = tk.StringVar(value="Ready")

        self._build_ui()
        self._refresh_all_status()
        self.after(100, self._drain_output_queue)

    def _build_ui(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(2, weight=2)
        self.rowconfigure(4, weight=3)

        top = ttk.Frame(self, padding=12)
        top.grid(row=0, column=0, sticky="ew")
        top.columnconfigure(1, weight=1)

        ttk.Label(top, text="Field / folder").grid(row=0, column=0, sticky="w", padx=(0, 8))
        self.channel_combo = ttk.Combobox(
            top,
            textvariable=self.channel_var,
            postcommand=self._refresh_channel_values,
        )
        self.channel_combo.grid(row=0, column=1, sticky="ew")
        self.channel_combo.bind("<<ComboboxSelected>>", self._on_channel_selected)

        controls = ttk.Frame(self, padding=(12, 0, 12, 8))
        controls.grid(row=1, column=0, sticky="ew")
        controls.columnconfigure(6, weight=1)

        self.create_button = ttk.Button(controls, text="Create Folder", command=self._create_folder)
        self.create_button.grid(row=0, column=0, padx=(0, 8))
        self.add_button = ttk.Button(controls, text="Add Links", command=self._add_links)
        self.add_button.grid(row=0, column=1, padx=(0, 8))
        self.download_button = ttk.Button(controls, text="Download All", command=self._download_all)
        self.download_button.grid(row=0, column=2, padx=(0, 8))
        self.clear_button = ttk.Button(controls, text="Clear Selected", command=self._clear_selected)
        self.clear_button.grid(row=0, column=3, padx=(0, 8))
        self.delete_button = ttk.Button(controls, text="Delete Folder", command=self._delete_selected)
        self.delete_button.grid(row=0, column=4, padx=(0, 8))
        self.stop_button = ttk.Button(controls, text="Stop", command=self._stop_process, state="disabled")
        self.stop_button.grid(row=0, column=5, padx=(0, 8))
        ttk.Label(controls, textvariable=self.status_var).grid(row=0, column=6, sticky="e")

        status_frame = ttk.LabelFrame(self, text="Folder status", padding=10)
        status_frame.grid(row=2, column=0, sticky="nsew", padx=12)
        status_frame.columnconfigure(0, weight=1)
        status_frame.rowconfigure(0, weight=1)

        columns = ("channel", "total", "downloaded", "failed", "pending", "folder")
        self.status_tree = ttk.Treeview(status_frame, columns=columns, show="headings", selectmode="browse")
        headings = {
            "channel": "Folder",
            "total": "Total",
            "downloaded": "Downloaded",
            "failed": "Failed",
            "pending": "Pending",
            "folder": "Path",
        }
        widths = {"channel": 210, "total": 70, "downloaded": 100, "failed": 80, "pending": 80, "folder": 360}
        for column in columns:
            self.status_tree.heading(column, text=headings[column])
            self.status_tree.column(column, width=widths[column], anchor="w")
        self.status_tree.bind("<<TreeviewSelect>>", self._on_status_selected)
        tree_scroll = ttk.Scrollbar(status_frame, command=self.status_tree.yview)
        self.status_tree.configure(yscrollcommand=tree_scroll.set)
        self.status_tree.grid(row=0, column=0, sticky="nsew")
        tree_scroll.grid(row=0, column=1, sticky="ns")

        urls_frame = ttk.LabelFrame(self, text="New URLs for selected folder", padding=10)
        urls_frame.grid(row=3, column=0, sticky="nsew", padx=12, pady=(8, 0))
        urls_frame.columnconfigure(0, weight=1)
        urls_frame.rowconfigure(0, weight=1)
        self.urls_text = tk.Text(urls_frame, height=7, wrap="word", undo=True)
        urls_scroll = ttk.Scrollbar(urls_frame, command=self.urls_text.yview)
        self.urls_text.configure(yscrollcommand=urls_scroll.set)
        self.urls_text.grid(row=0, column=0, sticky="nsew")
        urls_scroll.grid(row=0, column=1, sticky="ns")

        log_frame = ttk.LabelFrame(self, text="Status log", padding=10)
        log_frame.grid(row=4, column=0, sticky="nsew", padx=12, pady=12)
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)
        self.log_text = tk.Text(log_frame, height=10, wrap="word", state="disabled")
        log_scroll = ttk.Scrollbar(log_frame, command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=log_scroll.set)
        self.log_text.grid(row=0, column=0, sticky="nsew")
        log_scroll.grid(row=0, column=1, sticky="ns")

    def _refresh_channel_values(self) -> None:
        names = [summary.channel for summary in summarize_all(DOWNLOAD_ROOT)]
        self.channel_combo.configure(values=names)

    def _refresh_all_status(self) -> None:
        selected = self.channel_var.get()
        self._refresh_channel_values()
        self.status_tree.delete(*self.status_tree.get_children())
        for summary in summarize_all(DOWNLOAD_ROOT):
            self.status_tree.insert(
                "",
                "end",
                iid=summary.channel,
                values=(
                    summary.channel,
                    summary.total,
                    summary.downloaded,
                    summary.failed,
                    summary.pending,
                    str(summary.folder),
                ),
            )
        if selected and self.status_tree.exists(selected):
            self.status_tree.selection_set(selected)

    def _on_channel_selected(self, _event: tk.Event) -> None:
        channel = self.channel_var.get()
        if channel and self.status_tree.exists(channel):
            self.status_tree.selection_set(channel)
            self.status_tree.see(channel)

    def _on_status_selected(self, _event: tk.Event) -> None:
        selected = self.status_tree.selection()
        if selected:
            self.channel_var.set(selected[0])

    def _set_busy(self, busy: bool) -> None:
        state = "disabled" if busy else "normal"
        for button in (self.create_button, self.add_button, self.download_button, self.clear_button, self.delete_button):
            button.configure(state=state)
        self.stop_button.configure(state="normal" if busy else "disabled")

    def _append_log(self, text: str) -> None:
        self.log_text.configure(state="normal")
        self.log_text.insert("end", text.rstrip() + "\n")
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def _create_folder(self) -> None:
        try:
            summary = create_channel_folder(self.channel_var.get(), DOWNLOAD_ROOT)
        except Exception as exc:
            messagebox.showerror("Cannot create folder", str(exc))
            return
        self.channel_var.set(summary.channel)
        self._refresh_all_status()
        self._append_log(f"Created/kept folder: {summary.folder}")

    def _add_links(self) -> None:
        try:
            summary = add_links_to_channel(
                self.channel_var.get(),
                self.urls_text.get("1.0", "end"),
                DOWNLOAD_ROOT,
            )
        except Exception as exc:
            messagebox.showerror("Cannot add links", str(exc))
            return
        self.channel_var.set(summary.channel)
        self.urls_text.delete("1.0", "end")
        self._refresh_all_status()
        self._append_log(f"Saved links for {summary.channel}. Total URLs now: {summary.total}")

    def _download_all(self) -> None:
        path = batch_path(DOWNLOAD_ROOT)
        if not path.exists():
            messagebox.showerror("Cannot download", "Create a folder or add links first.")
            return

        command = [
            sys.executable,
            str(PROJECT_DIR / "process_clip_batch.py"),
            "--root",
            str(DOWNLOAD_ROOT),
            "--batch",
            str(path),
        ]
        self._run_command(command, "Download")

    def _clear_selected(self) -> None:
        channel = self.channel_var.get().strip()
        if not channel:
            messagebox.showerror("Cannot clear", "Select a folder first.")
            return
        if not messagebox.askyesno("Clear selected folder", f"Clear all URL/status/topic data for {channel}?"):
            return

        try:
            summary = clear_channel(channel, DOWNLOAD_ROOT)
        except Exception as exc:
            messagebox.showerror("Cannot clear", str(exc))
            return
        self.channel_var.set(summary.channel)
        self.urls_text.delete("1.0", "end")
        self._refresh_all_status()
        self._append_log(f"Cleared URL/status/topic data for {summary.channel}. Folder kept.")

    def _delete_selected(self) -> None:
        channel = self.channel_var.get().strip()
        if not channel:
            messagebox.showerror("Cannot delete", "Select a folder first.")
            return
        if not messagebox.askyesno(
            "Delete selected folder",
            f"Delete {channel} and remove it from url_clip.txt?\n\nThis also deletes downloaded clips in that folder.",
        ):
            return

        try:
            deleted = delete_channel(channel, DOWNLOAD_ROOT)
        except Exception as exc:
            messagebox.showerror("Cannot delete", str(exc))
            return
        self.channel_var.set("")
        self.urls_text.delete("1.0", "end")
        self._refresh_all_status()
        self._append_log(f"Deleted folder and batch section: {deleted}")

    def _run_command(self, command: list[str], label: str) -> None:
        if self.process is not None:
            messagebox.showwarning("Already running", "Wait for the current command to finish first.")
            return

        self._set_busy(True)
        self.status_var.set(f"{label} running")
        display_command = " ".join(f'"{part}"' if " " in part else part for part in command)
        self._append_log("")
        self._append_log(f"Running: {display_command}")

        self.running_thread = threading.Thread(
            target=self._command_worker,
            args=(command, label),
            daemon=True,
        )
        self.running_thread.start()

    def _command_worker(self, command: list[str], label: str) -> None:
        try:
            self.process = subprocess.Popen(
                command,
                cwd=PROJECT_DIR,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                bufsize=1,
            )
            assert self.process.stdout is not None
            for line in self.process.stdout:
                self.output_queue.put(line.rstrip())
            return_code = self.process.wait()
            self.output_queue.put(f"__DONE__:{label}:{return_code}")
        except Exception as exc:
            self.output_queue.put(f"__ERROR__:{label}:{exc}")

    def _drain_output_queue(self) -> None:
        try:
            while True:
                line = self.output_queue.get_nowait()
                if line.startswith("__DONE__:"):
                    _, label, return_code_text = line.split(":", 2)
                    return_code = int(return_code_text)
                    self.process = None
                    self._set_busy(False)
                    self._refresh_all_status()
                    if return_code == 0:
                        self.status_var.set(f"{label} complete")
                        self._append_log(f"{label} complete.")
                    else:
                        self.status_var.set(f"{label} failed")
                        self._append_log(f"{label} failed with exit code {return_code}.")
                elif line.startswith("__ERROR__:"):
                    _, label, error = line.split(":", 2)
                    self.process = None
                    self._set_busy(False)
                    self._refresh_all_status()
                    self.status_var.set(f"{label} error")
                    self._append_log(f"{label} error: {error}")
                else:
                    self._append_log(line)
                    if line.startswith("Channel: "):
                        self.status_var.set(f"Downloading {line.split(': ', 1)[1]}")
                    elif line.startswith("Skipping channel with no URLs:"):
                        self._refresh_all_status()
        except queue.Empty:
            pass
        self.after(100, self._drain_output_queue)

    def _stop_process(self) -> None:
        if self.process is None:
            return
        self._append_log("Stopping running command...")
        self.process.terminate()


def main() -> int:
    app = ClipBatchApp()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
