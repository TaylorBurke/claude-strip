import QtQuick

// A small hub-and-spokes glyph: the button that shows or hides this session's roundhouse map.
// Lit (accent, hub filled) while the map is shown; muted otherwise, brighter under the pointer.
Item {
    id: root
    property bool shown: false
    property color litColor: "#e0a458"
    property color dimColor: "#888888"
    property color hoverColor: "#ffffff"
    readonly property bool hovered: area.containsMouse
    readonly property color tint: shown ? litColor : (hovered ? hoverColor : dimColor)
    signal toggled()

    implicitWidth: 18
    implicitHeight: 18

    onTintChanged: glyph.requestPaint()
    onShownChanged: glyph.requestPaint()

    Canvas {
        id: glyph
        anchors.fill: parent
        onWidthChanged: requestPaint()
        onHeightChanged: requestPaint()
        onPaint: {
            var c = getContext("2d"), mid = width / 2, k = Math.min(width, height) / 18;
            c.reset();
            c.lineWidth = 1.4 * k;
            c.lineCap = "round";
            c.strokeStyle = root.tint;
            c.fillStyle = root.tint;
            for (var i = 0; i < 6; i++) {                       // six spokes, each ending in a dot
                var a = -Math.PI / 2 + i * Math.PI / 3, cs = Math.cos(a), sn = Math.sin(a);
                c.beginPath();
                c.moveTo(mid + cs * 4.2 * k, mid + sn * 4.2 * k);
                c.lineTo(mid + cs * 6.6 * k, mid + sn * 6.6 * k);
                c.stroke();
                c.beginPath();
                c.arc(mid + cs * 7.6 * k, mid + sn * 7.6 * k, 1.2 * k, 0, 2 * Math.PI);
                c.fill();
            }
            c.beginPath();
            c.arc(mid, mid, 3 * k, 0, 2 * Math.PI);             // the hub
            if (root.shown) c.fill(); else c.stroke();
        }
    }

    MouseArea {
        id: area
        objectName: "area"
        anchors.fill: parent
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.toggled()
    }
}
