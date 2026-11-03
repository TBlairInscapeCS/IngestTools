import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import ingest_watch as watch


class LocalDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.downloads = Path(self.tmp.name) / "Downloads"
        self.ingest = self.downloads / "Ingest"
        self.ingest.mkdir(parents=True)
        self.patch = patch.multiple(watch, DOWNLOADS_DIR=self.downloads, WATCH_DIR=self.ingest, LOCAL_MEDIA={})
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.job = "20261028-073600-SimulMedia"
        self.ids = ["QYPS0437000H", "QYPS0438000H"]

    def media(self, name, root=None, age=10):
        path = (root or self.downloads) / name
        path.write_bytes(b"test media")
        os.utime(path, (time.time() - age, time.time() - age))
        return path

    def test_downloads_without_manifest_and_no_moves(self):
        path = self.media("QYPS0437000H.mp4")
        self.media("OTHER1234000H.mp4")
        result = watch.discover_local_media(self.job, self.ids)
        self.assertEqual([f["name"] for f in result["files"]], [path.name])
        self.assertEqual(watch.local_media_files(self.job), [path.name])
        self.assertEqual(watch.resolve_local_file(self.job, path.name), path)
        self.assertTrue(path.exists())
        self.assertFalse((self.ingest / path.name).exists())

    def test_ingest_root_is_also_scanned(self):
        path = self.media("Brand_QYPS0438000H_30.mov", self.ingest)
        result = watch.discover_local_media(self.job, self.ids)
        self.assertEqual(result["files"][0]["source"], "Ingest")
        self.assertEqual(watch.resolve_local_file(self.job, path.name), path)

    def test_duplicate_candidates_require_manual_choice(self):
        self.media("QYPS0437000H.mp4")
        self.media("QYPS0437000H (1).mp4")
        result = watch.discover_local_media(self.job, self.ids)
        self.assertEqual(result["files"], [])
        self.assertEqual(len(result["ambiguous"]), 1)
        self.assertIsNone(watch.resolve_local_file(self.job, "QYPS0437000H.mp4"))

    def test_partial_id_and_unrelated_files_do_not_match(self):
        self.media("QYPS0437000H2.mp4")
        self.media("QYPS0438000H.txt")
        self.assertEqual(watch.discover_local_media(self.job, self.ids)["files"], [])

    def test_fresh_old_and_incomplete_files_are_ignored(self):
        self.media("QYPS0437000H.mp4", age=0)
        self.media("QYPS0438000H.mp4", age=15 * 86400)
        self.media("QYPS0437000H.mp4.crdownload")
        self.assertEqual(watch.discover_local_media(self.job, self.ids)["files"], [])

    def test_symlinks_and_subdirectories_are_not_followed(self):
        outside = Path(self.tmp.name) / "outside.mp4"
        outside.write_bytes(b"outside")
        (self.downloads / "QYPS0437000H.mp4").symlink_to(outside)
        nested = self.ingest / "other-job"
        nested.mkdir()
        self.media("QYPS0438000H.mp4", nested)
        self.assertEqual(watch.discover_local_media(self.job, self.ids)["files"], [])

    def test_ticker_batch_is_separate(self):
        self.media("QYPS0437000H.mp4")
        self.media("QYPS0437000H_t.mp4")
        watch.discover_local_media(self.job, self.ids, "_t")
        self.assertEqual(watch.local_media_files(self.job), ["QYPS0437000H.mp4"])
        self.assertEqual(watch.local_media_files(self.job, "ticker"), ["QYPS0437000H_t.mp4"])

    def test_changed_file_and_other_job_cannot_be_served(self):
        path = self.media("QYPS0437000H.mp4")
        watch.discover_local_media(self.job, self.ids)
        self.assertIsNone(watch.resolve_local_file("other-job", path.name))
        self.assertIsNone(watch.resolve_local_file(self.job, "../" + path.name))
        path.write_bytes(b"changed data")
        self.assertIsNone(watch.resolve_local_file(self.job, path.name))

    def test_invalid_requests_and_non_media_never_authorize_files(self):
        for job, ids in [("../job", self.ids), (self.job, []), (self.job, ["../../secret"]), (self.job, ["generic"] )]:
            with self.assertRaises(ValueError):
                watch.discover_local_media(job, ids)
        self.assertIsNone(watch.resolve_local_file(self.job, "unregistered.mp4"))


if __name__ == "__main__":
    unittest.main()
