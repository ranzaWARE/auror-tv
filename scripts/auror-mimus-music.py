#!/usr/bin/env python3
"""
Mimus with music, for the AUROR screen saver while music plays: twelve
pixel-art scenes in the cells of his sleeping and running sprites (5 px), his
white and AUROR's amber for what he plays, each four frames at 120 BPM.

    ./scripts/auror-mimus-music.py [folder]

writes mimus-<scene>-dark.gif into the folder, by default the saver's own
(server/assets/screensavers/auror).
"""
import os
import sys
from PIL import Image


INK = (240, 240, 245, 255)
AMB = (245, 160, 0, 255)
CELL, PAD = 5, 4

# His head, neck and body as the run sprite has them (rows 0-11).
UPPER = [
    "................###.....",
    "...............#######..",
    "...............#.##.....",
    "................##......",
    "................##......",
    "...............##.......",
    "..............##........",
    ".......#########........",
    "##..############........",
    ".################.......",
    "....###########.WW......",
    "........######..........",
]
LEGS = {
    'stand': ["........##..##..", "........##..##..", "........##..##..", "........###.###."],
    'liftL': ["........##..##..", "........##..##..", "........###.##..", "............###."],
    'liftR': ["........##..##..", "........##..##..", "........##..###.", "........###....."],
    'squat': ["........##..##..", ".......##....##.", ".......###...###"],
    # The run sprite's own strides, for walking in place.
    'run0': ["........##..##..", ".......##....##.", "......##......##", ".....##........##", "....##..........#", "...###..........###"],
    'run1': [".........##..##.", "........##....##", "........##.....#", ".......##......##", "......###.......##"],
}
PHONES = [(13, 0), (14, 0), (13, 1), (14, 1), (13, 2), (14, 2),
          (14, -1), (15, -2), (16, -2), (17, -2), (18, -2), (19, -1)]
QUAVER = [".ooo", ".o.o", ".o..", "oo..", "oo.."]
SEMIS = ["oooooo", "o....o", "o....o", "o...oo", "oo..oo", "oo...."]  # two notes beamed


class Frame:
    def __init__(self, w, h):
        self.w, self.h, self.c = w, h, {}

    def px(self, x, y, col=INK):
        if 0 <= x < self.w and 0 <= y < self.h:
            self.c[(x, y)] = col

    def clear(self, x, y):
        self.c.pop((x, y), None)

    def art(self, lines, ox, oy, cmap=None):
        cmap = cmap or {'#': INK, 'o': AMB}
        for y, row in enumerate(lines):
            for x, ch in enumerate(row):
                if ch in cmap:
                    self.px(ox + x, oy + y, cmap[ch])
                elif ch == '_':
                    self.clear(ox + x, oy + y)

    def rect(self, x0, y0, x1, y1, col=INK, fill=False):
        for y in range(y0, y1 + 1):
            for x in range(x0, x1 + 1):
                if fill or x in (x0, x1) or y in (y0, y1):
                    self.px(x, y, col)

    def note(self, x, y, kind=0):
        self.art(QUAVER if kind == 0 else SEMIS, x, y)

    def image(self, scale=1):
        img = Image.new('RGBA', (PAD + self.w * CELL, PAD + self.h * CELL), (0, 0, 0, 0))
        for (x, y), col in self.c.items():
            X, Y = PAD + x * CELL, PAD + y * CELL
            img.paste(col, (X, Y, X + CELL, Y + CELL))
        if scale != 1:
            img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
        return img


def mimus(f, ox, oy, legs='stand', dy=0, head=0, headdy=0, beak='shut', wing=True, wingdy=0, phones=False, tail=True):
    """Draws Mimus with his top-left at (ox, oy); dy lowers all but his feet."""
    for y, row in enumerate(UPPER):
        for x, ch in enumerate(row):
            if ch == '.':
                continue
            if ch == 'W' and not wing:
                continue
            if not tail and y == 8 and x < 2:
                continue
            xx, yy = x, y + dy
            if y <= 3:
                xx += head
                yy += headdy
            elif y <= 4:
                xx += head if head > 0 else 0
            if ch == 'W':
                yy += wingdy
            f.px(ox + xx, oy + yy, INK)
    if beak == 'open':
        # Upper beak raised a cell, the lower left where it was: a gap between.
        for x in (19, 20, 21):
            f.clear(ox + x + head, oy + 1 + dy + headdy)
            f.px(ox + x + head, oy + dy + headdy)
        for x in (19, 20):
            f.px(ox + x + head, oy + 2 + dy + headdy)
    hips = 12 + dy
    if legs:
        for y, row in enumerate(LEGS[legs]):
            for x, ch in enumerate(row):
                if ch == '#':
                    f.px(ox + x, oy + hips + y, INK)
    if phones:
        for (x, y) in PHONES:
            f.px(ox + x + head, oy + y + dy + headdy, AMB)


BEAT = 250   # ms a frame: two frames a beat at 120 BPM


def save(frames, path, durations=None):
    imgs = [fr.image() for fr in frames]
    d = durations or [BEAT] * len(imgs)
    imgs[0].save(path, save_all=True, append_images=imgs[1:], duration=d, loop=0, disposal=2, transparency=0)


# ---------------------------------------------------------------- 1 headphones
def headphones():
    out = []
    steps = [('liftL', 0, 1, -1, [(24, 4)]), ('squat', 1, 0, 0, [(24, 3)]),
             ('liftR', 0, 1, -1, [(25, 1), (7, 7)]), ('squat', 1, 0, 0, [(5, 5)])]
    for legs, dy, head, wing, notes in steps:
        f = Frame(30, 28)
        mimus(f, 2, 11, legs=legs, dy=dy, head=head, wingdy=wing, phones=True)
        for n in notes:
            f.note(*n)
        out.append(f)
    return out

# ---------------------------------------------------------------- 2 DJ console
def dj():
    out = []
    for i in range(4):
        f = Frame(42, 24)
        bob = i % 2
        ox, oy = 1, 6
        mimus(f, ox, oy, legs='stand' if not bob else 'squat', dy=bob, head=1 - bob, phones=True, wing=False)
        # The console in front of him, its top at his chest, platters on it,
        # knobs and a crossfader on its face.
        top = oy + 11
        f.rect(ox + 16, top, ox + 39, top, INK, fill=True)
        f.rect(ox + 17, top + 1, ox + 38, top + 4, INK)
        for x in (20, 23, 26, 32, 35):
            f.px(ox + x, top + 2, AMB)
        f.rect(ox + 21, top + 3, ox + 34, top + 3, INK)
        f.art(["oo"], ox + 26 + (2 if bob else 0), top + 3)
        for cx in (ox + 20, ox + 31):
            f.art([".oooooo.", "oooooooo"], cx, top - 2)
            f.clear([cx + 2, cx + 4, cx + 5, cx + 3][i], top - 2)
        # His wing on the left platter, scratching it back and forth.
        f.art(["######", ".....#"], ox + 15 + (1 if bob else 0), oy + 7 + bob)
        f.note(ox + 34, oy - 3 - (i % 2) * 2, 1 if i == 2 else 0)
        out.append(f)
    return out

# ---------------------------------------------------------------- 3 speakers
def speakers():
    out = []
    steps = [('liftL', 0, 1, -1), ('squat', 1, 0, 0), ('liftR', 0, 1, -1), ('squat', 1, 0, 0)]
    for i, (legs, dy, head, wing) in enumerate(steps):
        f = Frame(46, 24)
        mimus(f, 11, 6, legs=legs, dy=dy, head=head, wingdy=wing)
        loud = i % 2 == 0
        for sx in (1, 37):
            f.rect(sx, 7, sx + 7, 23, INK)
            f.art([".oo.", "o..o", ".oo."], sx + 2, 9)                 # tweeter
            if loud:                                                   # the woofer pushed out on the beat
                f.art(["..oooo..", ".o....o.", "o..oo..o", "o..oo..o", ".o....o.", "..oooo.."], sx, 14)
                f.rect(sx, 7, sx + 7, 23, INK)
            else:
                f.art([".oooo.", "o....o", "o.oo.o", "o.oo.o", "o....o", ".oooo."], sx + 1, 14)
        if loud:
            f.art(["o", ".o", ".o", "o"], 10, 14)
            f.art([".o", "o", "o", ".o"], 34, 14)
        out.append(f)
    return out

# ---------------------------------------------------------------- 4 saxophone
SAX = [
    "o.......",
    ".o......",
    "..o.....",
    "..o.....",
    "..oo....",
    "..oo....",
    "..oo....",
    "..oo....",
    "..oo..oo",
    "...oooo.",
    "....oo..",
]
def sax():
    out = []
    sway = [0, 1, 0, -1]
    for i in range(4):
        f = Frame(36, 28)
        hd = 1 if i % 2 else 0
        mimus(f, 2, 9, legs='stand' if i % 2 == 0 else 'squat', dy=i % 2, head=sway[i] if sway[i] > 0 else 0, headdy=0, wing=False)
        # The sax hangs from his beak down in front of him, its bell turned up.
        bx, by = 21 + (sway[i] if sway[i] > 0 else 0), 10 + i % 2
        f.art(SAX, bx, by)
        # His wing on the keys.
        f.art(["###"], 19, 18 + i % 2)
        f.px(bx + 3, by + 5 + (i % 2), INK)
        # Notes out of the bell.
        f.note(29, 16 - 3 * (i % 4) if i < 3 else 13)
        if i >= 2:
            f.note(31, 6 - (i - 2) * 3, 0)
        out.append(f)
    return out

# ---------------------------------------------------------------- 5 electric guitar
GUITAR = [
    "..............oo",
    ".............oo.",
    "............o...",
    "...........o....",
    "..........o.....",
    ".oooo....o......",
    "oooooooo........",
    "oo##ooo.........",
    "ooooooo.........",
    ".ooooo..........",
]
GUITAR = [
    "...............oo",
    "..............oo.",
    ".............oo..",
    "............oo...",
    "...........oo....",
    ".ooo......oo.....",
    "oooooo...oo......",
    "oo##ooooooo......",
    "oooooooo.........",
    ".oooooo..........",
    "..oooo...........",
]
def guitar():
    out = []
    for i in range(4):
        f = Frame(38, 26)
        down = i % 2
        ox, oy = 1, 9
        # On the beat his head goes down and up again: a headbang.
        mimus(f, ox, oy, legs='stand' if not down else 'squat', dy=down, head=1 if down else 0, headdy=down * 2, wing=False)
        # The guitar across his belly, its neck up to the right.
        f.art(GUITAR, ox + 13, oy + 3 + down)
        # His wing strums: up, then down.
        f.art(["##", "##"], ox + 15, oy + 6 + down + (2 if down else 0))
        if down:
            f.art(["o", ".o", "o"] if i == 1 else [".o", "o", ".o"], ox + 32, oy - 4 + i)
        out.append(f)
    return out

# ---------------------------------------------------------------- 6 drums
def drums():
    out = []
    for i in range(4):
        f = Frame(40, 26)
        ox, oy = 1, 8
        hit_snare = i % 2 == 0
        mimus(f, ox, oy, legs='squat' if hit_snare else 'stand', dy=1 if hit_snare else 0, head=1 if hit_snare else 0, wing=False)
        # The kit: a snare at his chest, a cymbal on its stand behind it, the bass drum face on.
        f.art(["oooooo", "#....#", "######"], ox + 19, oy + 10)
        f.art(["#"] * 13, ox + 27, oy + 4)
        f.art(["#.#.#"], ox + 25, oy + 16)
        f.art(["ooooooo"] if not hit_snare else ["ooo....", "...oooo"], ox + 24, oy + 3)
        f.art(["..######..", ".#......#.", "#...oo...#", "#..o..o..#", "#...oo...#", ".#......#.", "..######.."], ox + 28, oy + 9)
        # One stick in his wing, down on the snare, then up on the cymbal.
        if hit_snare:
            f.art(["####...", "...#oo.", "......o"], ox + 15, oy + 8)
            f.art(["o.o", ".o.", "o.o"], ox + 22, oy + 6)
        else:
            f.art([".......oo", ".....oo..", "####o...."], ox + 15, oy + 5)
            f.art(["o.o", ".o.", "o.o"], ox + 30, oy - 1)
        out.append(f)
    return out

# ---------------------------------------------------------------- 7 microphone
def microphone():
    out = []
    for i in range(4):
        f = Frame(34, 28)
        sing = i % 2 == 0
        mimus(f, 2, 10, legs='liftL' if i == 0 else 'liftR' if i == 2 else 'stand', dy=0, head=0, beak='open' if sing else 'shut', wing=False)
        # A mic on a stand in front of his beak; his wing on the stand.
        f.art(["ooo", "ooo"], 24, 10)
        f.art(["#"] * 15, 25, 12)
        f.art(["#####"], 23, 27)
        f.art(["####"], 21, 16)
        if sing:
            f.note(28, 4 - (i // 2) * 2, 1 if i == 0 else 0)
        else:
            f.note(29, 2 - (i // 2) * 2)
        out.append(f)
    return out

# ---------------------------------------------------------------- 8 disco ball
def discoball():
    out = []
    spark = [[(4, 22), (34, 20), (14, 27), (38, 26), (2, 9), (35, 8)],
             [(8, 25), (31, 23), (20, 26), (3, 19), (6, 6), (32, 11)],
             [(12, 21), (37, 24), (26, 27), (6, 27), (9, 9), (36, 5)],
             [(16, 26), (33, 27), (29, 22), (10, 23), (4, 4), (29, 7)]]
    for i in range(4):
        f = Frame(40, 30)
        up = i % 2 == 0
        ox, oy = 7, 12
        mimus(f, ox, oy, legs='liftL' if i == 0 else 'liftR' if i == 2 else 'squat', dy=0 if up else 1, head=1 if up else 0, wing=not up)
        if up:
            # Saturday night: the wing up, pointing at the ball.
            f.art(["....#", "...#.", "..#..", ".#...", "#...."], ox + 16, oy + 4)
        f.art(["#", "#"], 20, 0)
        ball = [".#o#o.", "#o#o#o", "o#o#o#", "#o#o#o", ".#o#o."] if i % 2 else [".o#o#.", "o#o#o#", "#o#o#o", "o#o#o#", ".o#o#."]
        f.art(ball, 18, 2)
        for (x, y) in spark[i]:
            f.art([".o.", "o.o", ".o."] if (x + y) % 2 else ["o"], x, y)
        out.append(f)
    return out

# ---------------------------------------------------------------- 9 keyboard
def keyboard():
    out = []
    for i in range(4):
        f = Frame(42, 26)
        ox, oy = 1, 7
        mimus(f, ox, oy, legs='stand', dy=i % 2, head=1 if i % 2 == 0 else 0, wing=False)
        # A keyboard on its stand in front of him, black keys between the white.
        kx, ky = ox + 19, oy + 11
        f.rect(kx, ky, kx + 20, ky + 3, INK)
        for x in range(kx + 1, kx + 20, 2):
            f.clear(x, ky + 2)
        for lx in (kx + 2, kx + 18):
            f.art(["#"] * 8, lx, ky + 4)
            f.art(["#.#"], lx - 1, ky + 12)
        # The key under his wing lights up.
        key = kx + [3, 8, 5, 12][i]
        f.art(["oo"], key, ky + 1)
        f.art(["#" * (key - ox - 15), "." * (key - ox - 16) + "#"], ox + 16, oy + 9 + (i % 2) - 1)
        f.note(kx + 15, oy - 3 - (i % 2) * 2, 1 if i == 2 else 0)
        out.append(f)
    return out

# ---------------------------------------------------------------- 10 boombox
def boombox():
    out = []
    runs = ['run0', 'run1', 'run0', 'run1']
    for i in range(4):
        f = Frame(34, 28)
        ox, oy = 2, 9 + (i % 2)
        mimus(f, ox, oy, legs=runs[i], dy=0, head=0, wing=False)
        # On his shoulder behind his head, a stereo: handle, two speakers, a tape between.
        bx, by = ox + 2, oy - 1
        f.art(["...oooooo...", "..o......o..", "oooooooooooo", "o.oo....oo.o", "oo..o..o..oo", "o.oo....oo.o", "oooooooooooo"], bx, by)
        if i % 2 == 0:
            f.art(["#", "#"], bx + 2, by + 3); f.art(["#", "#"], bx + 9, by + 3)
        f.art(["oo"], bx + 5, by + 4)
        # His wing up to hold it.
        f.art(["#", "#", "#"], ox + 14, oy + 4)
        f.note(ox + 26, oy - 7 - (i % 2) * 2, 0 if i < 2 else 1)
        out.append(f)
    return out

# ---------------------------------------------------------------- 11 conductor
def conductor():
    out = []
    # The baton's tip through four beats: down, left, right, up.
    tips = [(25, 19), (22, 13), (31, 14), (27, 6)]
    for i in range(4):
        f = Frame(38, 28)
        mimus(f, 2, 10, legs='stand', dy=0, head=1 if i in (0, 3) else 0, wing=False)
        # A music stand in front.
        f.art(["oooooooo", ".o....o.", "..oooo.."], 27, 17)
        f.art(["#"] * 8, 30, 20)
        f.art(["#.#.#"], 28, 27)
        # Wing to the baton's hand, the baton to its tip.
        hx, hy = 19, 17
        f.art(["##"], hx - 1, hy + 1)
        tx, ty = tips[i]
        steps = max(abs(tx - hx), abs(ty - hy))
        for s in range(steps + 1):
            x = hx + round((tx - hx) * s / steps)
            y = hy + round((ty - hy) * s / steps)
            f.px(x, y, INK if s < steps - 1 else AMB)
        f.note(33, 4 - i % 2 * 2, 1 if i == 3 else 0)
        out.append(f)
    return out

# ---------------------------------------------------------------- 12 orchestra
# A small Mimus, ten cells by ten, facing left toward the conductor.
MINI = [row[::-1] for row in [
    "......##..",
    ".....#####",
    ".....#.#..",
    "......#...",
    ".....#....",
    "#..####...",
    ".######...",
    "..####....",
    "..#..#....",
    "..#..#....",
]]


def mini(f, ox, oy, bob=0):
    for y, row in enumerate(MINI):
        for x, ch in enumerate(row):
            if ch == '#':
                f.px(ox + x, oy + y + (bob if y < 8 else 0), INK)


# Instruments in front of a small Mimus at (ox, oy), in frame i, bobbing by b.
def violin(f, ox, oy, i, b):
    f.art(["oo..", ".ooo", "..oo"], ox - 1, oy + 3 + b)
    d = (i % 2) * 2  # the bow, across the strings and back
    for k in range(5):
        f.px(ox - 2 + k + d, oy + 7 + b - k, INK)


def cello(f, ox, oy, i, b):
    f.art([".o", ".o", "ooo", "ooo", "ooo", ".o."], ox - 2, oy + 3)
    f.art(["#####"], ox - 4, oy + 6 + i % 2)


def flute(f, ox, oy, i, b):
    f.art(["oooooo"], ox - 5, oy + 2 + b)


def clarinet(f, ox, oy, i, b):
    for k in range(5):
        f.px(ox + 1 - k // 2, oy + 2 + b + k, AMB)
    f.art(["ooo"], ox - 2, oy + 7 + b)


def trumpet(f, ox, oy, i, b):
    up = i % 2
    f.art(["oooo"], ox - 3, oy + 1 + b - up)
    f.art(["o", "o", "o"], ox - 4, oy + b - up)


def trombone(f, ox, oy, i, b):
    out = 3 * (i % 2)  # the slide, in and out on the beat
    f.art(["ooooo"], ox - 4 - out, oy + 1 + b)
    f.art(["ooooo"], ox - 4 - out, oy + 3 + b)
    f.art(["o", "o", "o"], ox - 5 - out, oy + 1 + b)
    f.art(["o", "o", "o"], ox - 6, oy + b)


def timpani(f, ox, oy, i, b):
    f.art(["ooooo", "ooooo", ".ooo.", "..o..", ".o.o."], ox - 4, oy + 5)
    f.art(["#..", ".#."] if i % 2 else ["..#", ".#."], ox - 3 - (i + 1) % 2, oy + 3)


def horn(f, ox, oy, i, b):
    f.art([".ooo.", "o...o", "o.o.o", "o...o", ".ooo."], ox - 4, oy + 3 + b)


def harp(f, ox, oy, i, b):
    f.art(["ooooo", "o.#.o", "o.#.o", "o#.#o", "o#.#o", "o#.#o", "oooo."], ox - 6, oy + 2)


def orchestra():
    """Mimus on a podium, conducting fifteen small ones on three tiers."""
    out = []
    tips = [(25, 27), (22, 21), (31, 22), (27, 14)]
    rows = [  # back to front: top, first x, instruments
        (6, 40, [harp, trumpet, trombone, trumpet, timpani]),
        (17, 37, [horn, clarinet, flute, flute, cello]),
        (28, 34, [violin, violin, violin, violin, cello]),
    ]
    for i in range(4):
        f = Frame(100, 39)
        mimus(f, 2, 18, legs='stand', head=1 if i in (0, 3) else 0, wing=False)
        f.rect(4, 34, 22, 38, AMB)
        hx, hy = 19, 25
        f.art(["##"], hx - 1, hy + 1)
        tx, ty = tips[i]
        steps = max(abs(tx - hx), abs(ty - hy))
        for s in range(steps + 1):
            f.px(hx + round((tx - hx) * s / steps), hy + round((ty - hy) * s / steps), INK if s < steps - 1 else AMB)
        for oy, x0, kinds in rows:
            f.rect(x0 - 6, oy + 10, f.w - 1, oy + 10, AMB, fill=True)
            for k, play in enumerate(kinds):
                ox, b = x0 + k * 12, (i + k) % 2
                play(f, ox, oy, i, b)
                mini(f, ox, oy, bob=b)
        f.note(46 + (i * 7) % 20, i % 2, i == 2)
        f.note(80 - (i * 5) % 15, 1 - i % 2, i == 0)
        out.append(f)
    return out


VARIANTS = [('headphones', headphones), ('dj', dj), ('speakers', speakers), ('sax', sax), ('guitar', guitar),
            ('drums', drums), ('microphone', microphone), ('discoball', discoball), ('keyboard', keyboard),
            ('boombox', boombox), ('conductor', conductor), ('orchestra', orchestra)]


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'server', 'assets', 'screensavers', 'auror')
    for name, draw in VARIANTS:
        save(draw(), os.path.join(out, 'mimus-%s-dark.gif' % name))
    print('%d scenes in %s' % (len(VARIANTS), os.path.normpath(out)))


if __name__ == '__main__':
    main()
