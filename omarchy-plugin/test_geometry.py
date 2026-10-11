import unittest

import geometry


def win(address, at, size, mapped=True):
    return {"address": address, "at": at, "size": size, "mapped": mapped}


class Geometry(unittest.TestCase):
    def test_keeps_only_mapped_windows(self):
        got = geometry.geometry([win("a", [1, 2], [3, 4]), win("b", [0, 0], [1, 1], mapped=False)])
        self.assertEqual(got, {"a": (1, 2, 3, 4)})


class Changes(unittest.TestCase):
    def test_reports_new_and_moved_windows_only(self):
        previous = {"a": (0, 0, 10, 10), "b": (5, 5, 10, 10)}
        current = {"a": (0, 0, 10, 10), "b": (5, 5, 12, 10), "c": (1, 2, 3, 4)}
        self.assertEqual(geometry.changes(previous, current), ["b 5 5 12 10", "c 1 2 3 4"])

    def test_nothing_changed_prints_nothing(self):
        same = {"a": (0, 0, 10, 10)}
        self.assertEqual(geometry.changes(same, dict(same)), [])


if __name__ == "__main__":
    unittest.main()
