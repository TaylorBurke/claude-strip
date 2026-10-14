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
    readonly property var byPid: {
        const m = {};
        for (const s of sessions)
            m[s.pid] = s;
        return m;
    }

    // An opaque header drawn over the top of the terminal window, in the theme's
    // background color, so it reads as part of the window. It covers the top
    // 1-2 terminal rows.
    readonly property int padding: 14      // left inset, matches foot's pad=14x14
    readonly property int borderSize: 2    // Hyprland window border
    // The bar's height follows the system font size (Style.fontScale = base-size / 12).
    // Its text is sized per window to match that terminal's own text (see fontPx).
    readonly property int dividerHeight: 2
    // The box is sized for 18px text; the terminal-sized title is centered in it.
    readonly property int stripHeight: Math.round(18 * Style.fontScale * 1.6) + dividerHeight

    readonly property string followScript: Qt.resolvedUrl("follow.py").toString().replace("file://", "")
    readonly property string geometryScript: Qt.resolvedUrl("geometry.py").toString().replace("file://", "")
    readonly property string modSetupScript: Qt.resolvedUrl("mod_setup.py").toString().replace("file://", "")
    readonly property string scanScript: Qt.resolvedUrl("scan.py").toString().replace("file://", "")

    // The right-hand badge: kept short and out of the title's way so a long
    // title is what gets elided in a narrow window.
    function toolsText(s) {
        if (s.running > 0)
            return s.running + (s.running === 1 ? " tool running" : " tools running");
        return "";
    }

    function contextColor(pct) {
        return pct >= 85 ? Color.urgent : Color.accent;
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

    // The strip needs the session-strip Claude Code mod. If it is missing, ask (never
    // installing without a click on the notification), at most once a week.
    Process {
        id: modCheck
        command: ["python3", "-I", root.modSetupScript, "check"]
    }

    Component.onCompleted: modCheck.running = true

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

    // Window geometry (address -> {x, y, w}, global) streamed by geometry.py, which
    // samples Hyprland every frame while a window is resizing; it beats waiting for a scan.
    property var geo: ({})
    // Addresses whose window changed size within the last resizeSettle ms. A strip
    // hides while its window is resizing (trailing the edge looks laggy) and comes
    // back once the size has held still.
    property var resizing: ({})
    property var resizedAt: ({})
    readonly property int resizeSettle: 150

    Timer {
        id: resizeSettled
        interval: root.resizeSettle
        onTriggered: {
            const now = Date.now();
            const still = {};
            let any = false;
            for (const a in root.resizing) {
                if (now - root.resizedAt[a] < root.resizeSettle) {
                    still[a] = true;
                    any = true;
                }
            }
            root.resizing = still;
            if (any)
                resizeSettled.restart();
        }
    }

    Process {
        id: geometryWatch
        running: true
        command: ["python3", "-I", root.geometryScript]
        stdout: SplitParser {
            onRead: line => {
                const p = line.split(" ");
                const n = p.slice(1).map(Number);
                if (p.length === 5 && n.every(v => !isNaN(v))) {
                    const before = root.geo[p[0]];
                    if (before && (before.w !== n[2] || before.h !== n[3])) {
                        root.resizedAt[p[0]] = Date.now();
                        root.resizing = Object.assign({}, root.resizing, { [p[0]]: true });
                        resizeSettled.restart();
                    }
                    root.geo = Object.assign({}, root.geo, { [p[0]]: { x: n[0], y: n[1], w: n[2], h: n[3] } });
                }
            }
        }
        // Hyprland restarting ends the stream; try again shortly.
        onRunningChanged: {
            if (!running)
                geometryRetry.start();
        }
    }

    Timer {
        id: geometryRetry
        interval: 2000
        onTriggered: geometryWatch.running = true
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
        model: root.sessions.map(s => s.pid)

        PanelWindow {
            id: strip
            // The model is just each session's pid, so a window moving (which changes its
            // geometry on every scan) does not recreate the strip, and with it a drag in progress.
            required property var modelData
            readonly property var info: root.byPid[modelData] ?? ({ task: "", phase: "idle", running: 0, x: 0, y: 0, w: 0, mx: 0, my: 0, monitor: "", address: "" })
            property bool tipOpen: false
            // While the strip is dragged, follow.py reports the window's real geometry
            // (global x y w h) many times a second, which beats waiting for the next scan.
            property var live: null
            // The latest geometry: the drag's, else the streamed one, else the scan's.
            readonly property var frame: live ?? root.geo[info.address] ?? null
            // scan.py reports the terminal's font size in points; same size as the
            // terminal's own text (96 dpi), so the strip reads as part of the session.
            readonly property int fontPx: Math.round((info.fontPt ?? 10) * 96 / 72)

            // Resolved separately: binding visible to screen (which a visible
            // surface also sets) is a binding loop.
            readonly property var targetScreen: Quickshell.screens.find(s => s.name === info.monitor) ?? null

            screen: targetScreen
            // A fresh session has no task yet; leaving the strip off keeps Claude's
            // startup banner (and its mascot) visible until the first prompt.
            // Not while its window is resizing, except during the strip's own drag: hiding
            // the surface under a held mouse button would cancel the drag.
            readonly property bool resizeHidden: (root.resizing[info.address] ?? false) && live === null && !follow.running
            visible: targetScreen !== null && info.task.length > 0 && !resizeHidden

            anchors {
                top: true
                left: true
            }
            margins {
                left: (frame ? frame.x - info.mx : info.x) + root.borderSize
                top: (frame ? frame.y - info.my : info.y) + root.borderSize
            }
            implicitWidth: Math.max(0, (frame ? frame.w : info.w) - 2 * root.borderSize)
            implicitHeight: root.stripHeight

            WlrLayershell.layer: WlrLayer.Top
            WlrLayershell.namespace: "claude-strip"
            exclusionMode: ExclusionMode.Ignore
            color: "transparent"

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
                        color: root.dotColor(strip.info.phase)
                        font.family: Style.fontFamily
                        font.pixelSize: Math.round(strip.fontPx * 0.8)
                    }

                    // Right-hand status. While the agent waits on you it is only the red
                    // "waiting for you"; otherwise the tool count and a context-fill bar.
                    Row {
                        id: status
                        readonly property bool isWaiting: strip.info.phase === "waiting"
                        readonly property int context: strip.info.context ?? -1
                        readonly property int smallFont: Math.round(strip.fontPx * 0.85)

                        anchors {
                            right: parent.right
                            verticalCenter: parent.verticalCenter
                        }
                        spacing: 12

                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            visible: status.isWaiting
                            textFormat: Text.PlainText
                            text: "waiting for you"
                            color: Color.urgent
                            font.family: Style.fontFamily
                            font.pixelSize: status.smallFont
                        }

                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            visible: !status.isWaiting && strip.info.running > 0
                            textFormat: Text.PlainText
                            text: root.toolsText(strip.info)
                            color: Color.muted
                            font.family: Style.fontFamily
                            font.pixelSize: status.smallFont
                        }

                        Row {
                            anchors.verticalCenter: parent.verticalCenter
                            visible: !status.isWaiting && status.context >= 0
                            spacing: 8

                            Rectangle {
                                id: track
                                anchors.verticalCenter: parent.verticalCenter
                                width: Math.round(strip.fontPx * 5.5)
                                height: Math.round(strip.fontPx * 0.55)
                                radius: height / 2
                                color: Qt.alpha(Color.foreground, 0.18)

                                Rectangle {
                                    width: Math.max(track.height, track.width * Math.min(status.context, 100) / 100)
                                    height: parent.height
                                    radius: height / 2
                                    color: root.contextColor(status.context)
                                    visible: status.context > 0
                                }
                            }

                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                textFormat: Text.PlainText
                                text: status.context + "%"
                                color: Color.muted
                                font.family: Style.fontFamily
                                font.pixelSize: status.smallFont
                            }
                        }
                    }

                    Text {
                        id: title
                        anchors {
                            left: dot.right
                            leftMargin: 10
                            right: status.width > 0 ? status.left : parent.right
                            rightMargin: 14
                            verticalCenter: parent.verticalCenter
                        }
                        textFormat: Text.PlainText
                        text: strip.info.task
                        color: Color.foreground
                        elide: Text.ElideRight
                        font.family: Style.fontFamily
                        font.pixelSize: strip.fontPx
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
                    height: root.dividerHeight
                    color: strip.info.phase === "waiting" ? Color.urgent : Qt.alpha(Color.foreground, 0.3)
                }

                // Hovering the strip shows the whole title, but only when the window elides it.
                MouseArea {
                    id: hover
                    anchors.fill: parent
                    hoverEnabled: true
                    acceptedButtons: Qt.LeftButton

                    // Dragging the strip moves its window, live: follow.py runs while the mouse
                    // is held, so a floating window tracks the cursor and a tiled one swaps with
                    // each window the cursor enters. (A layer surface cannot hand a drag to
                    // Hyprland's own, so this reproduces it.)
                    property point pressAt: Qt.point(0, 0)

                    onPressed: mouse => {
                        pressAt = Qt.point(mouse.x, mouse.y);
                    }
                    onPositionChanged: mouse => {
                        if (pressed && !follow.running && Math.hypot(mouse.x - pressAt.x, mouse.y - pressAt.y) >= 8) {
                            strip.tipOpen = false;
                            follow.running = true;
                        }
                    }
                    onReleased: follow.write("stop\n")
                    onCanceled: follow.write("stop\n")

                    onContainsMouseChanged: {
                        if (containsMouse)
                            tipDelay.restart();
                        else {
                            tipDelay.stop();
                            strip.tipOpen = false;
                        }
                    }

                    Process {
                        id: follow
                        stdinEnabled: true
                        command: ["python3", "-I", root.followScript, strip.info.address]
                        stdout: SplitParser {
                            onRead: line => {
                                const p = line.split(" ").map(Number);
                                if (p.length === 4 && p.every(n => !isNaN(n)))
                                    strip.live = { x: p[0], y: p[1], w: p[2] };
                            }
                        }
                        onRunningChanged: {
                            if (!running)
                                strip.live = null;
                        }
                    }
                }

                Timer {
                    id: tipDelay
                    interval: 350
                    onTriggered: strip.tipOpen = hover.containsMouse
                }
            }

            PopupWindow {
                id: tip
                readonly property int maxWidth: Math.max(200, strip.width - 2 * root.padding)
                readonly property int bubblePadding: 10

                visible: strip.tipOpen && title.truncated
                color: "transparent"
                implicitWidth: Math.ceil(Math.min(metrics.width, maxWidth - 2 * bubblePadding)) + 2 * bubblePadding + 2
                implicitHeight: Math.ceil(label.implicitHeight) + 2 * bubblePadding + 2

                anchor {
                    window: strip
                    rect.x: root.padding
                    rect.y: strip.height + 4
                    rect.width: 1
                    rect.height: 1
                    edges: Edges.Top | Edges.Left
                    gravity: Edges.Bottom | Edges.Right
                    adjustment: PopupAdjustment.Slide
                }

                TextMetrics {
                    id: metrics
                    font.family: Style.fontFamily
                    font.pixelSize: Style.font.body
                    text: strip.info.task
                }

                Rectangle {
                    anchors.fill: parent
                    color: Color.tooltip.background
                    border.color: Color.tooltip.border
                    border.width: 1
                    radius: Style.cornerRadius

                    Text {
                        id: label
                        x: tip.bubblePadding + 1
                        y: tip.bubblePadding + 1
                        width: parent.width - 2 * (tip.bubblePadding + 1)
                        textFormat: Text.PlainText
                        text: strip.info.task
                        color: Color.tooltip.text
                        wrapMode: Text.WordWrap
                        font.family: Style.fontFamily
                        font.pixelSize: Style.font.body
                    }
                }
            }
        }
    }
}
