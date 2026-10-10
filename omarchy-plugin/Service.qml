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

    // An opaque header drawn over the top of the terminal window, in the theme's
    // background color, so it reads as part of the window. It covers the top
    // 1-2 terminal rows; raise or lower stripHeight/fontSize to taste.
    readonly property int padding: 14      // left inset, matches foot's pad=14x14
    readonly property int borderSize: 2    // Hyprland window border
    readonly property int fontSize: 25     // 2.5x the terminal's own text
    readonly property int stripHeight: 36  // includes the 1px divider line

    readonly property string scanScript: Qt.resolvedUrl("scan.py").toString().replace("file://", "")

    // The right-hand badge: kept short and out of the title's way so a long
    // title is what gets elided in a narrow window.
    function badge(s) {
        if (s.phase === "waiting")
            return "waiting for you";
        if (s.running > 0)
            return s.running + (s.running === 1 ? " tool running" : " tools running");
        return "";
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
                left: modelData.x + root.borderSize
                top: modelData.y + root.borderSize
            }
            implicitWidth: Math.max(0, modelData.w - 2 * root.borderSize)
            implicitHeight: root.stripHeight

            WlrLayershell.layer: WlrLayer.Top
            WlrLayershell.namespace: "claude-strip"
            exclusionMode: ExclusionMode.Ignore
            color: "transparent"
            mask: Region {}

            Rectangle {
                anchors.fill: parent
                color: Color.background

                Item {
                    id: content
                    anchors {
                        left: parent.left
                        right: parent.right
                        top: parent.top
                        bottom: divider.top
                        leftMargin: root.padding
                        rightMargin: root.padding
                    }

                    Text {
                        id: dot
                        anchors {
                            left: parent.left
                            verticalCenter: parent.verticalCenter
                        }
                        textFormat: Text.PlainText
                        text: "●"
                        color: root.dotColor(strip.modelData.phase)
                        font.family: Style.fontFamily
                        font.pixelSize: Math.round(root.fontSize * 0.8)
                    }

                    Text {
                        id: project
                        anchors {
                            left: dot.right
                            leftMargin: 10
                            verticalCenter: parent.verticalCenter
                        }
                        textFormat: Text.PlainText
                        text: strip.modelData.project
                        color: Color.foreground
                        font.family: Style.fontFamily
                        font.pixelSize: root.fontSize
                        font.bold: true
                    }

                    Text {
                        id: badge
                        anchors {
                            right: parent.right
                            verticalCenter: parent.verticalCenter
                        }
                        textFormat: Text.PlainText
                        text: root.badge(strip.modelData)
                        color: strip.modelData.phase === "waiting" ? Color.urgent : Color.muted
                        font.family: Style.fontFamily
                        font.pixelSize: Math.round(root.fontSize * 0.64)
                    }

                    Text {
                        anchors {
                            left: project.right
                            leftMargin: 10
                            right: badge.text.length > 0 ? badge.left : parent.right
                            rightMargin: 14
                            verticalCenter: parent.verticalCenter
                        }
                        textFormat: Text.PlainText
                        text: strip.modelData.task ? "· " + strip.modelData.task : ""
                        color: Qt.alpha(Color.foreground, 0.8)
                        elide: Text.ElideRight
                        font.family: Style.fontFamily
                        font.pixelSize: root.fontSize
                    }
                }

                // Thin divider, a muted tint of the theme's own foreground.
                Rectangle {
                    id: divider
                    anchors {
                        left: parent.left
                        right: parent.right
                        bottom: parent.bottom
                    }
                    height: 1
                    color: Qt.alpha(Color.foreground, 0.3)
                }
            }
        }
    }
}
