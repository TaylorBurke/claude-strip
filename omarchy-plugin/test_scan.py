import os
import unittest
from unittest import mock

import scan


class ParentOf(unittest.TestCase):
    def test_reads_own_parent(self):
        self.assertEqual(scan.parent_of(os.getpid()), os.getppid())

    def test_missing_pid_is_zero(self):
        self.assertEqual(scan.parent_of(2**22 + 12345), 0)


class WindowFor(unittest.TestCase):
    def test_walks_ancestors_to_the_window(self):
        parents = {300: 200, 200: 100, 100: 1}
        clients = {100: {"address": "0xabc"}}
        with mock.patch.object(scan, "parent_of", side_effect=lambda p: parents.get(p, 0)):
            self.assertEqual(scan.window_for(300, clients), {"address": "0xabc"})

    def test_no_window_when_chain_ends(self):
        with mock.patch.object(scan, "parent_of", return_value=0):
            self.assertIsNone(scan.window_for(300, {100: {}}))

    def test_cycle_does_not_hang(self):
        with mock.patch.object(scan, "parent_of", side_effect=lambda p: 5 if p == 6 else 6):
            self.assertIsNone(scan.window_for(6, {}))


if __name__ == "__main__":
    unittest.main()
