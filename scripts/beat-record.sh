#!/bin/sh
#
# scripts/beat-record.sh - record 60 s of the TV's audio output for the beat corpus
#
#   scripts/beat-record.sh <tv> <name> <bpm|unknown> <steady y|n> [steadyFrom]
#
# <name> names the file (<name>.raw); <bpm> is the track's reference tempo or
# unknown; <steady> says whether the beat holds; <steadyFrom> is the second
# the beat becomes steady, for a piece that starts without one. Run it on the
# computer while the piece plays on the TV. Dev tool, not deployed.
#
# Records on the TV with arecord, copies the file to the corpus folder
# ($AUROR_BEAT_CORPUS, default ~/Progetti/Sviluppo/auror-beat-corpus), checks
# its size, deletes it from the TV even on failure, and appends a row to
# manifest.tsv there. SSH logs in as root unless TV_SSH_USER says otherwise.
#
# Refuses while /tmp/auror-beat-capture.pid names a live process: hw:0,12 may
# refuse a second reader. Turn "Mimus on the beat" off, or keep the screen
# saver from showing.
#
set -e

[ $# -ge 4 ] && [ $# -le 5 ] || { sed -n '3,5p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
tv=$1
name=$2
bpm=$3
steady=$4
steady_from=${5:-}

# 60 s x 48000 Hz x 2 channels x 2 bytes
expected=11520000
corpus=${AUROR_BEAT_CORPUS:-$HOME/Progetti/Sviluppo/auror-beat-corpus}
manifest="$corpus/manifest.tsv"
target="${TV_SSH_USER:-root}@$tv"
remote="/tmp/$name.raw"

die() { echo "beat-record: $*" >&2; exit 2; }
is_number() { case "$1" in ''|*[!0-9.]*|.*|*.|*.*.*) return 1 ;; esac; }

case "$name" in ''|*[!A-Za-z0-9._+-]*|.*) die "name takes letters, digits and . _ + - only, not starting with a dot" ;; esac
[ "$bpm" = unknown ] || { is_number "$bpm" && [ "$bpm" != 0 ]; } || die "bpm is a number or unknown"
case "$steady" in y|n) ;; *) die "steady is y or n" ;; esac
[ -z "$steady_from" ] || is_number "$steady_from" || die "steadyFrom is a number of seconds"

on_tv() { ssh -o ConnectTimeout=8 -o BatchMode=yes "$target" "$@"; }

mkdir -p "$corpus"
if [ -f "$manifest" ] && cut -f1 "$manifest" | grep -qxF -- "$name"; then
  die "$name is already in $manifest"
fi
[ ! -e "$corpus/$name.raw" ] || die "$corpus/$name.raw already exists"

# shellcheck disable=SC2016 # expanded on the TV
if on_tv 'pid=$(cat /tmp/auror-beat-capture.pid 2>/dev/null); [ -n "$pid" ] && [ -d "/proc/$pid" ]'; then
  die "the beat capture is running on the TV: turn \"Mimus on the beat\" off, or keep the screen saver from showing, then try again"
fi

done_ok=0
# arecord is stopped too: without a terminal, Ctrl-C here does not reach it.
cleanup() {
  # [a]record: the pattern must not match this shell's own command line.
  on_tv "pkill -f '[a]record .*$remote' 2>/dev/null; rm -f '$remote'" >/dev/null 2>&1 ||
    echo "beat-record: could not delete $remote from the TV" >&2
  [ "$done_ok" = 1 ] || rm -f "$corpus/$name.raw"
}
trap cleanup EXIT
# dash runs no EXIT trap when a signal ends it.
trap 'exit 130' INT TERM HUP

echo "recording 60 s on $tv ..."
on_tv "arecord -D hw:0,12 -c 2 -f S16_LE -r 48000 -t raw -d 60 '$remote'"
scp -q -o ConnectTimeout=8 -o BatchMode=yes "$target:$remote" "$corpus/$name.raw"

size=$(wc -c < "$corpus/$name.raw" | tr -d ' ')
[ "$size" = "$expected" ] || { echo "beat-record: $name.raw is $size bytes, expected $expected" >&2; exit 1; }

[ -f "$manifest" ] || printf 'name\tbpm\tsteady\tsteadyFrom\n' > "$manifest"
printf '%s\t%s\t%s\t%s\n' "$name" "$bpm" "$steady" "$steady_from" >> "$manifest"
done_ok=1
echo "saved $corpus/$name.raw ($size bytes), row added to $manifest"
