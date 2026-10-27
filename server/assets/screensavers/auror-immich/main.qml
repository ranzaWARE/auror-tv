/*
 * AUROR · Immich screen saver: photos from Immich one at a time, crossfading
 * every half minute and drawing slowly nearer while shown, with the time and
 * the photo's date and place in the lower corners. Dimmed unless set bright.
 *
 * The photos are the ones Glasshouse Home's settings chose (an album, or the
 * library at random), listed by the server (lib/auror-immich) and passed on
 * by it with Immich's key added, so none is kept here. With Immich not
 * linked or not answering, the time alone, drifting on black as AUROR's own.
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

    property int level: __TVWEB_LEVEL__
    // How bright a photo is shown: dimmed spares the panel over hours.
    property real shown: level > 0 ? 1.0 : 0.72
    property color ink: level > 0 ? "#e0e4ea" : "#99a2af"

    property var items: []
    property int at: 0
    // The image the next photo loads into; the other is on screen.
    property bool intoA: true
    property bool photos: items.length > 0

    function two(n) { return n < 10 ? "0" + n : "" + n }

    Image {
        id: picA
        width: win.width
        height: win.height
        fillMode: Image.PreserveAspectCrop
        asynchronous: true
        cache: false
        opacity: 0
        transformOrigin: Item.Center
        Behavior on opacity { NumberAnimation { duration: 1800; easing.type: Easing.InOutQuad } }
        onStatusChanged: if (status === Image.Ready && win.intoA) win.reveal(picA, picB)
    }

    Image {
        id: picB
        width: win.width
        height: win.height
        fillMode: Image.PreserveAspectCrop
        asynchronous: true
        cache: false
        opacity: 0
        transformOrigin: Item.Center
        Behavior on opacity { NumberAnimation { duration: 1800; easing.type: Easing.InOutQuad } }
        onStatusChanged: if (status === Image.Ready && !win.intoA) win.reveal(picB, picA)
    }

    // The lower edge darkened, so the time and the caption read on any photo.
    Rectangle {
        width: win.width
        height: 260
        y: win.height - height
        visible: win.photos
        gradient: Gradient {
            GradientStop { position: 0.0; color: "#00000000" }
            GradientStop { position: 1.0; color: "#a6000000" }
        }
    }

    Text {
        id: caption
        x: 96 + win.driftX
        y: win.height - 84 - height
        visible: win.photos
        font.family: grotesk.status === FontLoader.Ready ? grotesk.name : ""
        font.pixelSize: 30
        font.weight: Font.Light
        color: win.ink
        text: ""
    }

    Text {
        id: clock
        x: win.photos ? win.width - 96 - width + win.driftX : (win.width - width) / 2 + win.driftX
        y: win.photos ? win.height - 76 - height : (win.height - height) / 2 + win.driftY
        font.family: grotesk.status === FontLoader.Ready ? grotesk.name : ""
        font.pixelSize: win.photos ? 64 : 200
        font.weight: Font.Light
        font.letterSpacing: win.photos ? -2 : -7
        color: win.photos ? win.ink : (win.level > 0 ? "#e0e4ea" : "#7d8592")
        text: "00:00"
    }

    property real driftX: 0
    property real driftY: 0

    // The time and caption wander a few pixels, so nothing stays lit in one place.
    ParallelAnimation {
        id: glide
        NumberAnimation { id: glideX; target: win; property: "driftX"; duration: 180000; easing.type: Easing.InOutSine }
        NumberAnimation { id: glideY; target: win; property: "driftY"; duration: 180000; easing.type: Easing.InOutSine }
        onRunningChanged: if (!running) win.wander()
    }

    function wander() {
        glideX.to = (Math.random() * 2 - 1) * (win.photos ? 24 : 90);
        glideY.to = (Math.random() * 2 - 1) * (win.photos ? 0 : 60);
        glide.start();
    }

    // The new photo fades in, drawing nearer for as long as it is shown; the old one out.
    function reveal(img, old) {
        img.scale = 1.0;
        img.opacity = win.shown;
        old.opacity = 0;
        win.intoA = !win.intoA;
        nearer.target = img;
        nearer.restart();
        var it = win.items[(win.at + win.items.length - 1) % win.items.length];
        caption.text = it ? win.when(it.date) + (it.place ? (it.date ? "  ·  " : "") + it.place : "") : "";
    }

    NumberAnimation { id: nearer; property: "scale"; from: 1.0; to: 1.06; duration: 32000 }

    function when(d) {
        if (!d) return "";
        var p = d.split("-");
        return Qt.formatDate(new Date(+p[0], +p[1] - 1, +p[2]), "d MMMM yyyy");
    }

    function next() {
        if (!win.items.length) return;
        var it = win.items[win.at % win.items.length];
        win.at = win.at + 1;
        var url = win.origin + "/api/home/immich/thumb?id=" + it.id + "&size=preview";
        if (win.intoA) picA.source = url; else picB.source = url;
    }

    function readPhotos() {
        if (!win.origin) return;
        var x = new XMLHttpRequest();
        x.onreadystatechange = function () {
            if (x.readyState !== XMLHttpRequest.DONE || x.status !== 200) return;
            try {
                var r = JSON.parse(x.responseText);
                if (r && r.items && r.items.length) {
                    var first = !win.items.length;
                    win.items = r.items;
                    win.at = 0;
                    if (first) win.next();
                }
            } catch (e) { }
        };
        x.open("GET", win.origin + "/api/home/immich/saver");
        x.send();
    }

    function refresh() {
        var now = new Date();
        clock.text = win.two(now.getHours()) + ":" + win.two(now.getMinutes());
    }

    Timer { interval: 1000; running: true; repeat: true; onTriggered: win.refresh() }
    Timer { interval: 30000; running: true; repeat: true; onTriggered: win.next() }
    // A new order each hour; and again a minute on, should Immich not have answered.
    Timer { interval: win.photos ? 3600000 : 60000; running: true; repeat: true; onTriggered: win.readPhotos() }

    Component.onCompleted: {
        refresh();
        readPhotos();
        wander();
    }
}
