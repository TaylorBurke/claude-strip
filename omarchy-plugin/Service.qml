import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import Quickshell.Hyprland
import qs.Commons

// One thin strip per terminal window that runs a Claude Code session, drawn in
// the window's top padding. Sessions come from scan.py, which joins the state
// files the session-strip Claude Code mod writes with Hyprland's window list.
Item {
    id: root

    property var shell: null
    property var sessions: []

    // The strip sits inside the terminal's own top padding (foot: pad=14x14),
    // so it never covers text. Adjust if your terminal pads differently.
    readonly property int padding: 14
    readonly property int borderSize: 2

    readonly property string scanScript: Qt.resolvedUrl("scan.py").toString().replace("file://", "")

    function describe(s) {
        const parts = [s.project, s.task];
        if (s.phase === "waiting")
            parts.push("waiting for you");
        else if (s.running > 0)
            parts.push(s.running + (s.running === 1 ? " tool running" : " tools running"));
        return parts.filter(p => p && p.length > 0).join(" · ");
    }

    function dotColor(phase) {
        if (phase === "waiting")
            return Color.urgent;
        return phase === "working" ? Color.accent : Color.muted;
    }

    function scanNow() {
        if (!scan.running)
            scan.running = true;
    }

    Process {
        id: scan
        // Output is capped, and the deadline timer below kills a hung scan.
        command: ["sh", "-c", "python3 -I \"$1\" | head -c 65536", "claude-strip-scan", root.scanScript]
        stdout: StdioCollector {
            onStreamFinished: {
                try {
                    root.sessions = JSON.parse(text);
                } catch (e) {
                    root.sessions = [];
                }
            }
        }
    }

    Timer {
        id: scanDeadline
        interval: 5000
        running: scan.running
        onTriggered: scan.running = false
    }

    // State files change without any Hyprland event, so poll gently; window
    // moves, focus and workspace changes arrive as events and rescan at once.
    Timer {
        interval: 1000
        running: true
        repeat: true
        triggeredOnStart: true
        onTriggered: root.scanNow()
    }

    Timer {
        id: debounce
        interval: 40
        onTriggered: root.scanNow()
    }

    Connections {
        target: Hyprland
        function onRawEvent(event) {
            debounce.restart();
        }
    }

    Variants {
        model: root.sessions

        PanelWindow {
            id: strip
            required property var modelData

            screen: Quickshell.screens.find(s => s.name === modelData.monitor) ?? null
            visible: screen !== null

            anchors {
                top: true
                left: true
            }
            margins {
                left: modelData.x + root.borderSize + root.padding
                top: modelData.y + root.borderSize
            }
            implicitWidth: Math.max(0, modelData.w - 2 * (root.borderSize + root.padding))
            implicitHeight: root.padding

            WlrLayershell.layer: WlrLayer.Top
            WlrLayershell.namespace: "claude-strip"
            exclusionMode: ExclusionMode.Ignore
            color: "transparent"
            mask: Region {}

            Row {
                anchors.fill: parent
                spacing: 6

                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: "●"
                    color: root.dotColor(strip.modelData.phase)
                    font.family: Style.fontFamily
                    font.pixelSize: 9
                }

                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    width: parent.width - 15
                    textFormat: Text.PlainText
                    text: root.describe(strip.modelData)
                    color: Color.foreground
                    elide: Text.ElideRight
                    font.family: Style.fontFamily
                    font.pixelSize: 10
                }
            }
        }
    }
}
