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


class LooseSweepTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ingest = Path(self.tmp.name) / "Ingest"
        self.archive = self.ingest / "_archive"
        self.ingest.mkdir(parents=True)
        self.patch = patch.multiple(watch, WATCH_DIR=self.ingest, ARCHIVE_DIR=self.archive)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def file(self, name, age=0):
        p = self.ingest / name
        p.write_text("data")
        t = time.time() - age
        os.utime(p, (t, t))
        return p

    def manifest(self, slug, files, age=0):
        p = self.file(slug + "-manifest.json", 0)
        p.write_text(__import__("json").dumps({"job": slug, "files": [{"file": f} for f in files]}))
        t = time.time() - age
        os.utime(p, (t, t))
        return p

    def test_old_unreferenced_files_fold_into_loose_archive(self):
        self.file("stray.mp4", age=10 * 86400)
        self.file("shot.jpg", age=30 * 86400)
        self.file("fresh.mp4", age=3600)
        watch.prune_loose()
        self.assertFalse((self.ingest / "stray.mp4").exists())
        self.assertTrue((self.archive / "_loose" / "stray.mp4").exists())
        self.assertTrue((self.archive / "_loose" / "shot.jpg").exists())
        self.assertTrue((self.ingest / "fresh.mp4").exists())

    def test_manifest_referenced_files_are_never_swept(self):
        self.manifest("20261106-072207-Horizon", ["ZPMK0154000H.mp4"], age=1)
        self.file("ZPMK0154000H.mp4", age=30 * 86400)
        # Delivered-name drift: stem-prefix counts as referenced too.
        self.file("ZPMK0155000H Gifting 15s.mp4", age=30 * 86400)
        self.manifest("20261106-080000-Horizon", ["ZPMK0155000H.mp4"], age=1)
        watch.prune_loose()
        self.assertTrue((self.ingest / "ZPMK0154000H.mp4").exists())
        self.assertTrue((self.ingest / "ZPMK0155000H Gifting 15s.mp4").exists())

    def test_stale_manifest_family_folds_with_report_and_state(self):
        mp = self.manifest("20261010-010101-Old", ["OLD.mp4"], age=20 * 86400)
        self.file("20261010-010101-Old-manifest-report.json", age=20 * 86400)
        self.file(".20261010-010101-Old-manifest-state.json", age=20 * 86400)
        fresh = self.manifest("20261119-010101-New", ["NEW.mp4"], age=0)
        watch.prune_loose()
        dest = self.archive / "20261010-010101-Old"
        self.assertTrue((dest / mp.name).exists())
        self.assertTrue((dest / "20261010-010101-Old-manifest-report.json").exists())
        self.assertTrue((dest / ".20261010-010101-Old-manifest-state.json").exists())
        self.assertTrue(fresh.exists())

    def test_sweep_archived_job_never_renames_watch_root(self):
        watch.sweep_archived_job(self.ingest)
        self.assertTrue(self.ingest.exists())


if __name__ == "__main__":
    unittest.main()
