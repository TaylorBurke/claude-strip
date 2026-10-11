import unittest

import follow


def win(address, at, size, floating=False, ws=1):
    return {"address": address, "at": at, "size": size, "floating": floating,
            "mapped": True, "hidden": False, "workspace": {"id": ws}}


class WindowAt(unittest.TestCase):
    clients = [win("a", [0, 0], [100, 100]), win("b", [100, 0], [100, 100]),
               win("f", [100, 0], [50, 50], floating=True), win("c", [100, 0], [100, 100], ws=2)]

    def test_finds_the_tiled_window_under_the_point(self):
        self.assertEqual(follow.window_at(self.clients, 150, 80, "a", {1})["address"], "b")

    def test_skips_the_dragged_window_floating_windows_and_other_workspaces(self):
        self.assertIsNone(follow.window_at(self.clients, 50, 50, "a", {1}))
        self.assertEqual(follow.window_at(self.clients, 120, 20, "a", {1})["address"], "b")

    def test_nothing_under_the_point(self):
        self.assertIsNone(follow.window_at(self.clients, 500, 500, "a", {1}))
