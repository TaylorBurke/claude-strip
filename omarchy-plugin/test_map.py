"""Runs test_map.qml (the map icon's click and the rebind logic) under qmltestrunner; needs qt6-declarative."""
import os
import shutil
import subprocess
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = shutil.which("qmltestrunner") or next(
    (p for p in ("/usr/lib/qt6/bin/qmltestrunner",) if os.access(p, os.X_OK)), None)


@unittest.skipUnless(RUNNER, "qmltestrunner (qt6-declarative) not found")
class MapQml(unittest.TestCase):
    def test_map_qml(self):
        env = {**os.environ, "QT_QPA_PLATFORM": "offscreen"}
        run = subprocess.run([RUNNER, "-input", os.path.join(HERE, "test_map.qml")],
                             env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(run.returncode, 0, run.stdout + run.stderr)


if __name__ == "__main__":
    unittest.main()
