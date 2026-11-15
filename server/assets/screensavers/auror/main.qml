/*
 * AUROR screen saver: black for the OLED panel, Mimus asleep in the middle
 * and the time beneath him, dimmed. While music plays in Spotify or another
 * music app, Mimus plays along instead, in one of twelve scenes at random,
 * another every few minutes (scripts/auror-mimus-music.py draws them). The pair drifts a little round the middle
 * without stopping, so no pixel stays lit in one place. With the mascots
 * switched off in Home's settings, which this reads from the server, the time
 * is left alone.
 *
 * Where the server hears the song (lib/auror-beat), Mimus keeps to its tempo
 * instead of his GIF's own 120 BPM, and to its beat once the server's output
 * latency is calibrated (until then it sends phase false), asking for the beat
 * each second while music plays: the GIF is paused and its frame
 * set on each half-beat, beat.js working out which, as AnimatedImage's
 * speed needs QtQuick 2.11 and webOS 4 and 5 have 2.6 and 2.9.
 *
 * Mounted over com.webos.app.screensaver like the others; the GIF beside this
 * file is staged with it. The fonts come from the server and fall back to the
 * platform's own while it is not answering.
 */
import QtQuick 2.4
import Eos.Window 0.1
import "beat.js" as Beat

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
    // Following the beat, from Home's settings.
    property bool followBeat: true
    // The language Home was last shown in, from the server: the saver has none of its own.
    property string lang: ""
    // Music playing in front (the server says), and the scene Mimus plays it in.
    property bool music: false
    property var scenes: ["headphones", "dj", "speakers", "sax", "guitar", "drums", "microphone", "discoball", "keyboard", "boombox", "conductor", "orchestra"]
    property int scene: -1
    // The server's beat while Mimus follows it, else null; his anchor and tempo (beat.js).
    property var beat: null
    property var beatState: null
    // When the server last answered the look and the beat: a beat older than 15 s is let go.
    property real lookAt: 0
    property real beatAt: 0
    // The server has no beat route (an older one, or the demo): the look alone carries the beat.
    property bool noBeatRoute: false
    property bool beatBusy: false
    // Steps tried while the GIF had no frames yet.
    property int noFrames: 0
    property bool following: beat !== null && mascots && music && scene >= 0
    // Any scene to start with; after that, any but the one showing.
    function newScene() {
        if (scene < 0) { scene = Math.floor(Math.random() * scenes.length); return; }
        var next = Math.floor(Math.random() * (scenes.length - 1));
        scene = next >= scene ? next + 1 : next;
    }

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
            width: sourceSize.width * 3
            height: sourceSize.height * 3
            smooth: false
            source: win.music && win.scene >= 0 ? "mimus-" + win.scenes[win.scene] + "-dark.gif" : "mimus-sleep-dark.gif"
            visible: win.mascots
            playing: visible
            paused: win.following
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
        // The server away: the GIF goes back to its own 120 BPM.
        if (win.beat !== null && Date.now() - Math.max(win.lookAt, win.beatAt) > 15000) win.takeBeat(null);
        if (!win.origin) return;
        var x = new XMLHttpRequest();
        x.onreadystatechange = function () {
            if (x.readyState !== XMLHttpRequest.DONE || x.status !== 200) return;
            try {
                var r = JSON.parse(x.responseText);
                win.lookAt = Date.now();
                if (r && r.look && typeof r.look.mascots === "boolean") win.mascots = r.look.mascots;
                if (r && r.look) win.followBeat = r.look.followBeat !== false;
                if (r && typeof r.lang === "string" && r.lang !== win.lang) { win.lang = r.lang; win.refresh(); }
                if (r && typeof r.music === "boolean" && r.music !== win.music) {
                    if (r.music) win.newScene();
                    win.music = r.music;
                }
                // Following switched off, or the music gone: let the beat go at once.
                if (!win.followBeat || !win.music) win.takeBeat(null);
                // One source at a time: while the beat poll answers, the beat is its.
                else if (Date.now() - win.beatAt > 3000) win.takeBeat(r ? Beat.usable(r.beat, Date.now()) : null);
            } catch (e) { }
        };
        x.open("GET", win.origin + "/api/home/look");
        x.send();
    }

    // The beat each second while Mimus may follow it, so a new tempo shows within a second.
    function readBeat() {
        // One request at a time: answers queued behind a stalled server could
        // arrive out of order and put an older beat over a newer one.
        if (!win.origin || win.beatBusy) return;
        win.beatBusy = true;
        var x = new XMLHttpRequest();
        x.onreadystatechange = function () {
            if (x.readyState !== XMLHttpRequest.DONE) return;
            win.beatBusy = false;
            // Only a 404 stops it: a server not answering (0) or failing (5xx) is asked again.
            if (x.status === 404) { win.noBeatRoute = true; return; }
            if (x.status !== 200) return;
            win.beatAt = Date.now();
            try {
                var r = JSON.parse(x.responseText);
                win.takeBeat(r ? Beat.usable(r.beat, Date.now()) : null);
            } catch (e) { }
        };
        x.open("GET", win.origin + "/api/home/look/beat");
        x.send();
    }

    function takeBeat(b) {
        win.beatState = b ? Beat.follow(win.beatState, b, Date.now()) : null;
        win.beat = b;
        if (win.following) win.step();
        else stepper.stop();
    }

    // The frame for now, and the timer set for the next half-beat.
    function step() {
        if (!win.following || !win.beatState) return;
        // A GIF still loading has no frames yet: try again shortly, for up to
        // 2 s, then let it play on its own.
        if (mimus.frameCount < 1) {
            if (++win.noFrames > 40) { win.noFrames = 0; win.takeBeat(null); return; }
            stepper.interval = 50;
            stepper.restart();
            return;
        }
        win.noFrames = 0;
        var now = Date.now();
        mimus.currentFrame = Beat.frameAt(win.beatState, now, mimus.frameCount);
        stepper.interval = Beat.untilNext(win.beatState, now);
        stepper.restart();
    }

    function refresh() {
        var now = new Date();
        clock.text = win.two(now.getHours()) + ":" + win.two(now.getMinutes());
        // Qt.formatDate writes the engine's own locale, English on the TV.
        date.text = (win.lang ? now.toLocaleDateString(Qt.locale(win.lang), "dddd d MMMM") : Qt.formatDate(now, "dddd d MMMM")).toUpperCase();
    }

    Timer { interval: 1000; running: true; repeat: true; onTriggered: win.refresh() }
    // Often enough to hear when the music starts or stops.
    Timer { interval: 5000; running: true; repeat: true; onTriggered: win.readLook() }
    Timer { interval: 1000; running: win.music && win.mascots && win.followBeat && !win.noBeatRoute; repeat: true; onTriggered: win.readBeat() }
    Timer { interval: 180000; running: win.music; repeat: true; onTriggered: win.newScene() }
    Timer { id: stepper; repeat: false; onTriggered: win.step() }
    onFollowingChanged: if (following) step(); else stepper.stop()

    Component.onCompleted: {
        refresh();
        readLook();
        wander();
    }
}
