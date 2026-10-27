/*
 * AUROR screen saver: black for the OLED panel, Mimus asleep in the middle
 * and the time beneath him, dimmed. The pair drifts a little round the middle
 * without stopping, so no pixel stays lit in one place. With the mascots
 * switched off in Home's settings, which this reads from the server, the time
 * is left alone.
 *
 * Mounted over com.webos.app.screensaver like the others; the GIF beside this
 * file is staged with it. The fonts come from the server and fall back to the
 * platform's own while it is not answering.
 */
import QtQuick 2.4
import Eos.Window 0.1

WebOSWindow {
    id: win

    width: 1920
    height: 1080

    windowType: "_WEBOS_WINDOW_TYPE_SCREENSAVER"
    appId: "com.webos.app.screensaver"
    title: "Screen Saver"
    visible: true
    color: "black"

    property string statsUrl: "__TVWEB_URL__"
    property string origin: statsUrl.substring(0, statsUrl.indexOf("/api/"))

    FontLoader { id: grotesk; source: win.origin + "/assets/fonts/SpaceGrotesk.ttf" }
    FontLoader { id: mono;    source: win.origin + "/assets/fonts/SpaceMono-Regular.ttf" }

    /*
     * Dim keeps everything well short of white: the point of a screen saver
     * is to spare the panel for hours. Bright is for a bright room.
     */
    property int level: __TVWEB_LEVEL__
    property color ink:   level > 0 ? "#e0e4ea" : "#7d8592"
    property color muted: level > 0 ? "#99a2af" : "#5d6472"
    property bool mascots: true

    function two(n) { return n < 10 ? "0" + n : "" + n }

    // Where the pair is drawn: the middle, moved by the drift below.
    property real driftX: 0
    property real driftY: 0

    Column {
        id: pair
        spacing: 28
        x: (win.width - width) / 2 + win.driftX
        y: (win.height - height) / 2 + win.driftY

        // 128 x 98, drawn three times over with its pixels kept square.
        AnimatedImage {
            id: mimus
            x: (pair.width - width) / 2
            width: 384
            height: 294
            smooth: false
            source: "mimus-sleep-dark.gif"
            visible: win.mascots
            playing: visible
            opacity: win.level > 0 ? 0.85 : 0.5
        }

        Text {
            id: clock
            x: (pair.width - width) / 2
            font.family: grotesk.status === FontLoader.Ready ? grotesk.name : ""
            font.pixelSize: win.mascots ? 96 : 200
            font.weight: Font.Light
            font.letterSpacing: win.mascots ? -3 : -7
            color: win.ink
            text: "00:00"
        }

        Text {
            id: date
            x: (pair.width - width) / 2
            font.family: mono.status === FontLoader.Ready ? mono.name : ""
            font.pixelSize: 20
            font.letterSpacing: 1.5
            color: win.muted
            text: ""
        }
    }

    /*
     * Each glide takes three minutes to a spot up to 90 px across and 60 px
     * up or down from the middle, and the next starts as it ends.
     */
    ParallelAnimation {
        id: glide
        NumberAnimation { id: glideX; target: win; property: "driftX"; duration: 180000; easing.type: Easing.InOutSine }
        NumberAnimation { id: glideY; target: win; property: "driftY"; duration: 180000; easing.type: Easing.InOutSine }
        onRunningChanged: if (!running) win.wander()
    }

    function wander() {
        glideX.to = (Math.random() * 2 - 1) * 90;
        glideY.to = (Math.random() * 2 - 1) * 60;
        glide.start();
    }

    function readLook() {
        if (!win.origin) return;
        var x = new XMLHttpRequest();
        x.onreadystatechange = function () {
            if (x.readyState !== XMLHttpRequest.DONE || x.status !== 200) return;
            try {
                var r = JSON.parse(x.responseText);
                if (r && r.look && typeof r.look.mascots === "boolean") win.mascots = r.look.mascots;
            } catch (e) { }
        };
        x.open("GET", win.origin + "/api/home/look");
        x.send();
    }

    function refresh() {
        var now = new Date();
        clock.text = win.two(now.getHours()) + ":" + win.two(now.getMinutes());
        date.text = Qt.formatDate(now, "dddd d MMMM").toUpperCase();
    }

    Timer { interval: 1000; running: true; repeat: true; onTriggered: win.refresh() }
    Timer { interval: 600000; running: true; repeat: true; onTriggered: win.readLook() }

    Component.onCompleted: {
        refresh();
        readLook();
        wander();
    }
}
