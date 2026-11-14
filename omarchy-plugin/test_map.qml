// Run with:  QT_QPA_PLATFORM=offscreen /usr/lib/qt6/bin/qmltestrunner -input test_map.qml
import QtQuick
import QtTest
import "map.js" as MapJs

Item {
    width: 100; height: 40

    MapIcon { id: icon; litColor: "#e0a458"; dimColor: "#888888"; hoverColor: "#ffffff" }
    SignalSpy { id: spy; target: icon; signalName: "toggled" }

    TestCase {
        name: "MapIcon"
        when: windowShown

        function init() { spy.clear(); icon.shown = false; }

        function test_a_click_asks_for_a_toggle() {
            mouseClick(icon);
            mouseClick(icon);
            compare(spy.count, 2);
        }
        function test_lit_when_shown() {
            compare(icon.tint.toString(), "#888888");
            icon.shown = true;
            compare(icon.tint.toString(), "#e0a458");
        }
        function test_brighter_under_the_pointer_unless_lit() {
            mouseMove(icon, 9, 9);
            compare(icon.hovered, true);
            compare(icon.tint.toString(), "#ffffff");
            icon.shown = true;
            compare(icon.tint.toString(), "#e0a458");
            mouseMove(icon, 90, 30);
        }
    }

    TestCase {
        name: "rebinds"
        function test_a_changed_id_is_a_rebind() {
            var r = MapJs.rebinds({ 100: "aaaaaaaa" }, [{ pid: 100, sid: "bbbbbbbb" }]);
            compare(r.pairs, [["aaaaaaaa", "bbbbbbbb"]]);
            compare(r.known, { 100: "bbbbbbbb" });
        }
        function test_nothing_changed_or_nothing_known_is_no_rebind() {
            compare(MapJs.rebinds({ 100: "aaaaaaaa" }, [{ pid: 100, sid: "aaaaaaaa" }]).pairs, []);
            compare(MapJs.rebinds({}, [{ pid: 100, sid: "aaaaaaaa" }]).pairs, []);        // first sight
        }
        function test_sessions_without_an_id_are_left_alone() {
            var r = MapJs.rebinds({ 100: "aaaaaaaa" }, [{ pid: 100, sid: "" }, { pid: 200, sid: "cccccccc" }]);
            compare(r.pairs, []);
            compare(r.known, { 100: "aaaaaaaa", 200: "cccccccc" });     // 100 keeps what we knew
        }
        function test_a_strip_missing_from_one_scan_still_rebinds_when_back() {
            var gone = MapJs.rebinds({ 100: "aaaaaaaa" }, []);
            compare(gone.pairs, []);
            var back = MapJs.rebinds(gone.known, [{ pid: 100, sid: "bbbbbbbb" }]);
            compare(back.pairs, [["aaaaaaaa", "bbbbbbbb"]]);
        }
        function test_each_strip_is_judged_on_its_own_pid() {
            var r = MapJs.rebinds({ 1: "aaaaaaaa", 2: "bbbbbbbb" }, [{ pid: 1, sid: "aaaaaaaa" }, { pid: 2, sid: "dddddddd" }]);
            compare(r.pairs, [["bbbbbbbb", "dddddddd"]]);
        }
    }
}
