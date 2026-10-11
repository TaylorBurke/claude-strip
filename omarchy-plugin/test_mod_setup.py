import os
import tempfile
import unittest
from unittest import mock

import mod_setup


class AskedRecently(unittest.TestCase):
    def test_no_marker_means_never_asked(self):
        with mock.patch.object(mod_setup, "MARKER", "/nonexistent/marker"):
            self.assertFalse(mod_setup.asked_recently(1e12))

    def test_marker_age_decides(self):
        with tempfile.NamedTemporaryFile() as marker, mock.patch.object(mod_setup, "MARKER", marker.name):
            now = os.path.getmtime(marker.name)
            self.assertTrue(mod_setup.asked_recently(now + 60))
            self.assertFalse(mod_setup.asked_recently(now + mod_setup.ASK_EVERY + 1))


class Check(unittest.TestCase):
    def test_does_nothing_when_the_mod_is_installed(self):
        with mock.patch.object(mod_setup.shutil, "which", return_value="/bin/x"), \
                mock.patch.object(mod_setup, "asked_recently", return_value=False), \
                mock.patch.object(mod_setup, "mod_installed", return_value=True), \
                mock.patch.object(mod_setup, "notify") as notify:
            mod_setup.check()
            notify.assert_not_called()

    def test_installs_only_after_a_click(self):
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(mod_setup, "MARKER", os.path.join(d, "m")), \
                mock.patch.object(mod_setup.shutil, "which", return_value="/bin/x"), \
                mock.patch.object(mod_setup, "mod_installed", return_value=False), \
                mock.patch.object(mod_setup, "install") as install:
            with mock.patch.object(mod_setup, "notify", return_value=""):
                mod_setup.check()
            install.assert_not_called()
            os.unlink(os.path.join(d, "m"))
            with mock.patch.object(mod_setup, "notify", return_value="default"):
                mod_setup.check()
            install.assert_called_once()
