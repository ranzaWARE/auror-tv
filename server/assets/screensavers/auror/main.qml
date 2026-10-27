/*
 * AUROR screen saver: Glasshouse Home's clock, dimmed on black, wandering
 * slowly and without stopping. Now and then Mimus dozes beside it or Quetza
 * glides past, unless they are switched off in Home's settings, which this
 * reads from the server.
 *
 * Mounted over com.webos.app.screensaver like the others; the GIFs beside
 * this file are staged with it. The fonts come from the server and fall back
 * to the platform's own while it is not answering.
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
     * Dim keeps the digits well short of white: the point of a screen saver
     * is to spare the panel for hours. Bright is for a bright room.
     */
    property int level: __TVWEB_LEVEL__
    property color ink:   level > 0 ? "#e0e4ea" : "#7d8592"
    property color muted: level > 0 ? "#99a2af" : "#5d6472"
    property color mark:  "#b47400"
    property bool mascots: true

    function two(n) { return n < 10 ? "0" + n : "" + n }

    Item {
        id: block
        width: face.width + 40 + mimus.width
        height: face.height

        Column {
            id: face
            spacing: 36

            Text {
                id: clock
                font.family: grotesk.status === FontLoader.Ready ? grotesk.name : ""
                font.pixelSize: 220
                font.weight: Font.Light
                font.letterSpacing: -8
                color: win.ink
                text: "00:00"
            }
            Row {
                spacing: 14
                Rectangle {
                    width: 12
                    height: 12
                    radius: 2
                    color: win.mark
                    y: (date.height - height) / 2
                }
                Text {
                    id: date
                    font.family: mono.status === FontLoader.Ready ? mono.name : ""
                    font.pixelSize: 24
                    font.letterSpacing: 1.5
                    color: win.muted
                    text: ""
                }
            }
        }

        AnimatedImage {
            id: mimus
            x: face.width + 40
            y: face.height - height - 4
            width: 192
            height: 147
            smooth: false
            source: "mimus-sleep-dark.gif"
            opacity: 0
            Behavior on opacity { NumberAnimation { duration: 1200 } }
        }
    }

    /*
     * The block never rests: each glide takes a minute and a half to a spot a
     * good way off, and the next starts as it ends.
     */
    ParallelAnimation {
        id: glide
        NumberAnimation { id: glideX; target: block; property: "x"; duration: 90000; easing.type: Easing.InOutSine }
        NumberAnimation { id: glideY; target: block; property: "y"; duration: 90000; easing.type: Easing.InOutSine }
        onRunningChanged: if (!running) win.wander()
    }

    function wander() {
        var margin = 120;
        var spanX = Math.max(0, win.width - block.width - margin * 2);
        var spanY = Math.max(0, win.height - block.height - margin * 2);
        var nx = 0, ny = 0;
        for (var i = 0; i < 8; i++) {
            nx = margin + Math.random() * spanX;
            ny = margin + Math.random() * spanY;
            if (Math.abs(nx - block.x) > win.width / 5 || Math.abs(ny - block.y) > win.height / 5) break;
        }
        glideX.to = nx;
        glideY.to = ny;
        glide.start();
    }

    AnimatedImage {
        id: quetza
        width: 295
        height: 160
        smooth: false
        source: "quetza-dark.gif"
        x: -340
        y: 90
        visible: false
        opacity: win.level > 0 ? 0.8 : 0.45
        playing: visible
    }

    NumberAnimation {
        id: flight
        target: quetza
        property: "x"
        from: -340
        to: 2240
        duration: 16000
        easing.type: Easing.InOutSine
        onRunningChanged: if (!running) quetza.visible = false
    }

    // Mimus or Quetza every four to twelve minutes.
    Timer {
        id: mascotTimer
        interval: 240000
        repeat: true
        running: true
        onTriggered: {
            interval = 240000 + Math.random() * 480000;
            if (!win.mascots) { mimus.opacity = 0; return; }
            if (Math.random() < 0.5) {
                mimus.opacity = mimus.opacity > 0 ? 0 : (win.level > 0 ? 0.85 : 0.5);
            } else if (!flight.running) {
                quetza.y = 60 + Math.random() * 160;
                quetza.visible = true;
                flight.start();
            }
        }
    }

    function readLook() {
        if (!win.origin) return;
        var x = new XMLHttpRequest();
        x.onreadystatechange = function () {
            if (x.readyState !== XMLHttpRequest.DONE || x.status !== 200) return;
            try {
                var r = JSON.parse(x.responseText);
                if (r && r.look && typeof r.look.mascots === "boolean") win.mascots = r.look.mascots;
                if (!win.mascots) mimus.opacity = 0;
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
        block.x = 280;
        block.y = 300;
        wander();
    }
}
