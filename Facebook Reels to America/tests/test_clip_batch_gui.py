from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from clip_batch_gui import (
    BATCH_FILE_NAME,
    add_links_to_channel,
    clear_channel,
    create_channel_folder,
    delete_channel,
    extract_urls,
    sanitize_channel_name,
    summarize_all,
)
from process_clip_batch import BatchGroup, Clip, parse_batch_groups, write_batch_groups


WORKSPACE_TEMP_ROOT = Path(__file__).resolve().parents[1]


def workspace_temp_dir() -> TemporaryDirectory[str]:
    return TemporaryDirectory(dir=WORKSPACE_TEMP_ROOT)


class ClipBatchGuiTests(unittest.TestCase):
    def test_sanitize_channel_name_replaces_windows_path_separators(self) -> None:
        self.assertEqual(sanitize_channel_name("  My Field: A/B?  "), "My-Field-A-B")

    def test_sanitize_channel_name_rejects_empty_names(self) -> None:
        with self.assertRaisesRegex(ValueError, "field/folder name"):
            sanitize_channel_name("   ")

    def test_extract_urls_deduplicates_and_strips_trailing_punctuation(self) -> None:
        text = """
        first https://example.com/a,
        duplicate https://example.com/a
        second https://www.instagram.com/reel/abc/)
        """
        self.assertEqual(
            extract_urls(text),
            [
                "https://example.com/a",
                "https://www.instagram.com/reel/abc/",
            ],
        )

    def test_create_channel_folder_writes_empty_central_section(self) -> None:
        with workspace_temp_dir() as temp_dir:
            root = Path(temp_dir)
            summary = create_channel_folder("1-page Test", root)

            self.assertEqual(summary.channel, "1-page-Test")
            self.assertEqual(summary.total, 0)
            self.assertTrue(summary.folder.is_dir())

            groups = parse_batch_groups(root / BATCH_FILE_NAME)
            self.assertEqual(len(groups), 1)
            self.assertEqual(groups[0].channel, "1-page-Test")
            self.assertEqual(groups[0].clips, [])

    def test_add_links_appends_channel_without_deleting_previous_channel(self) -> None:
        with workspace_temp_dir() as temp_dir:
            root = Path(temp_dir)
            first = add_links_to_channel("channel one", "https://example.com/1\nhttps://example.com/2", root)
            second = add_links_to_channel("channel two", "https://example.com/3", root)

            self.assertEqual(first.total, 2)
            self.assertEqual(second.total, 1)

            groups = parse_batch_groups(root / BATCH_FILE_NAME)
            self.assertEqual([group.channel for group in groups], ["channel-one", "channel-two"])
            self.assertEqual([clip.url for clip in groups[0].clips], ["https://example.com/1", "https://example.com/2"])
            self.assertEqual([clip.url for clip in groups[1].clips], ["https://example.com/3"])

    def test_add_links_deduplicates_within_same_channel_and_preserves_status(self) -> None:
        with workspace_temp_dir() as temp_dir:
            root = Path(temp_dir)
            write_batch_groups(
                root / BATCH_FILE_NAME,
                [
                    BatchGroup(
                        "field",
                        [Clip(seq=1, url="https://example.com/1", status="Downloaded", topic="done")],
                    )
                ],
            )

            summary = add_links_to_channel("field", "https://example.com/1\nhttps://example.com/2", root)

            self.assertEqual(summary.total, 2)
            groups = parse_batch_groups(root / BATCH_FILE_NAME)
            self.assertEqual(groups[0].clips[0].status, "Downloaded")
            self.assertEqual(groups[0].clips[0].topic, "done")
            self.assertEqual([clip.url for clip in groups[0].clips], ["https://example.com/1", "https://example.com/2"])

    def test_clear_channel_clears_only_selected_channel_and_keeps_folder(self) -> None:
        with workspace_temp_dir() as temp_dir:
            root = Path(temp_dir)
            add_links_to_channel("field", "https://example.com/1", root)
            add_links_to_channel("other", "https://example.com/2", root)

            summary = clear_channel("field", root)

            self.assertEqual(summary.total, 0)
            self.assertTrue(summary.folder.is_dir())
            groups = parse_batch_groups(root / BATCH_FILE_NAME)
            field = next(group for group in groups if group.channel == "field")
            other = next(group for group in groups if group.channel == "other")
            self.assertEqual(field.clips, [])
            self.assertEqual([clip.url for clip in other.clips], ["https://example.com/2"])

    def test_delete_channel_removes_folder_and_central_section_only_for_selected_channel(self) -> None:
        with workspace_temp_dir() as temp_dir:
            root = Path(temp_dir)
            add_links_to_channel("field", "https://example.com/1", root)
            add_links_to_channel("other", "https://example.com/2", root)
            (root / "field" / "old.mp4").write_text("old", encoding="utf-8")
            (root / "other" / "keep.mp4").write_text("keep", encoding="utf-8")

            deleted = delete_channel("field", root)

            self.assertEqual(deleted, "field")
            self.assertFalse((root / "field").exists())
            self.assertTrue((root / "other" / "keep.mp4").exists())
            groups = parse_batch_groups(root / BATCH_FILE_NAME)
            self.assertEqual([group.channel for group in groups], ["other"])
            self.assertEqual([clip.url for clip in groups[0].clips], ["https://example.com/2"])

    def test_summarize_all_includes_folder_without_batch_section(self) -> None:
        with workspace_temp_dir() as temp_dir:
            root = Path(temp_dir)
            (root / "manual-folder").mkdir()

            summaries = summarize_all(root)

            self.assertEqual(len(summaries), 1)
            self.assertEqual(summaries[0].channel, "manual-folder")
            self.assertEqual(summaries[0].total, 0)


class ProcessClipBatchMultiChannelTests(unittest.TestCase):
    def test_parse_batch_groups_reads_multiple_channel_sections(self) -> None:
        with workspace_temp_dir() as temp_dir:
            path = Path(temp_dir) / BATCH_FILE_NAME
            path.write_text(
                "\n".join(
                    [
                        "Channel Name: one",
                        "",
                        "1.",
                        "URL: https://example.com/1",
                        "Status: Downloaded",
                        "Topic: first",
                        "",
                        "Channel Name: two",
                        "",
                        "1.",
                        "URL: https://example.com/2",
                        "Status:",
                        "Topic:",
                    ]
                ),
                encoding="utf-8",
            )

            groups = parse_batch_groups(path)

            self.assertEqual([group.channel for group in groups], ["one", "two"])
            self.assertEqual(groups[0].clips[0].status, "Downloaded")
            self.assertEqual(groups[1].clips[0].url, "https://example.com/2")

    def test_write_batch_groups_renumbers_each_channel_independently(self) -> None:
        with workspace_temp_dir() as temp_dir:
            path = Path(temp_dir) / BATCH_FILE_NAME
            write_batch_groups(
                path,
                [
                    BatchGroup("one", [Clip(seq=99, url="https://example.com/1")]),
                    BatchGroup(
                        "two",
                        [
                            Clip(seq=40, url="https://example.com/2"),
                            Clip(seq=41, url="https://example.com/3"),
                        ],
                    ),
                ],
            )

            groups = parse_batch_groups(path)

            self.assertEqual([clip.seq for clip in groups[0].clips], [1])
            self.assertEqual([clip.seq for clip in groups[1].clips], [1, 2])


if __name__ == "__main__":
    unittest.main()
