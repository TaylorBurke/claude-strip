import os
import unittest
from unittest import mock

import scan


class ParentOf(unittest.TestCase):
    def test_reads_own_parent(self):
        self.assertEqual(scan.parent_of(os.getpid()), os.getppid())

    def test_missing_pid_is_zero(self):
        self.assertEqual(scan.parent_of(2**22 + 12345), 0)


class ParseFontPt(unittest.TestCase):
    def test_foot(self):
        self.assertEqual(scan.parse_font_pt("foot", "[main]\nfont=JetBrainsMono Nerd Font:size=10\n"), 10.0)

    def test_alacritty_reads_the_font_section_only(self):
        text = "[window]\nsize = 99\n[font]\nsize = 9\n[cursor]\nsize = 1\n"
        self.assertEqual(scan.parse_font_pt("alacritty", text), 9.0)

    def test_ghostty_and_kitty(self):
        self.assertEqual(scan.parse_font_pt("ghostty", "font-size = 9\n"), 9.0)
        self.assertEqual(scan.parse_font_pt("kitty", "# font_size 12\nfont_size 13.5\n"), 13.5)

    def test_unset_or_unknown_is_none(self):
        self.assertIsNone(scan.parse_font_pt("foot", "[main]\nterm=xterm\n"))
        self.assertIsNone(scan.parse_font_pt("wezterm", "font_size 12"))


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


class RecoverDrags(unittest.TestCase):
    def test_retiles_a_window_whose_follower_died(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d, \
                mock.patch.object(scan, "STATE_DIR", d), \
                mock.patch.object(scan.subprocess, "run") as run:
            dead = os.path.join(d, "drag-0xabc123.pending")
            alive = os.path.join(d, "drag-0xdef456.pending")
            with open(dead, "w") as f:
                f.write(str(2**22 + 12345))
            with open(alive, "w") as f:
                f.write(str(os.getpid()))
            scan.recover_drags()
            self.assertEqual(run.call_count, 1)
            self.assertIn("address:0xabc123", run.call_args[0][0][-1])
            self.assertFalse(os.path.exists(dead))
            self.assertTrue(os.path.exists(alive))


class FloatersAbove(unittest.TestCase):
    @staticmethod
    def client(addr, floating, focus, ws=1, at=(0, 0), size=(100, 100), **kw):
        return dict(address=addr, floating=floating, focusHistoryID=focus, mapped=True,
                    hidden=False, workspace={"id": ws}, at=list(at), size=list(size), **kw)

    def test_floating_window_covers_a_tiled_one(self):
        tiled = self.client("a", False, 5)
        float_ = self.client("b", True, 9, at=(10, 20), size=(30, 40))
        self.assertEqual(scan.floaters_above(tiled, [tiled, float_]), [[10, 20, 30, 40, "b"]])

    def test_ignores_tiled_other_workspace_hidden_and_self(self):
        win = self.client("a", False, 5)
        others = [self.client("b", False, 1), self.client("c", True, 1, ws=2),
                  dict(self.client("d", True, 1), hidden=True),
                  dict(self.client("e", True, 1), mapped=False), win]
        self.assertEqual(scan.floaters_above(win, others), [])

    def test_floating_pair_stacks_by_focus(self):
        top = self.client("a", True, 0)
        under = self.client("b", True, 3)
        self.assertEqual(scan.floaters_above(under, [top, under]), [[0, 0, 100, 100, "a"]])
        self.assertEqual(scan.floaters_above(top, [top, under]), [])
