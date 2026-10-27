#!/usr/bin/env python3
"""AUROR's releases, run by .github/workflows/auror.yml.

  scripts/auror-release.py sync      merge Glasshouse's latest release into
                                     the checked-out main, or open a pull
                                     request for it when it does not merge clean
  scripts/auror-release.py version   set TVWEB_VERSION to the next AUROR
                                     version, when the server changed since the
                                     last AUROR release
  scripts/auror-release.py notes     write the release notes to dist/notes.md

AUROR versions keep Glasshouse's major and minor and count AUROR's builds in
the patch from 101: 0.122.101, 0.122.102, then 0.123.101 once Glasshouse's
0.123 is merged. They stay three numbers, as a webOS package needs, and never
meet a Glasshouse version, whose patch is small.

Each command prints key=value lines for the workflow's outputs.
"""
import json
import os
import re
import subprocess
import sys

UPSTREAM = 'rorygallagher2024/glasshouse'
TVWEB = 'server/tvweb.js'
VERSION_LINE = re.compile(r"^var TVWEB_VERSION = '([^']+)';$", re.M)
FIRST_BUILD = 101
DRY = os.environ.get('AUROR_DRY_RUN') == '1'


def sh(*cmd, check=True, capture=True):
    r = subprocess.run(cmd, text=True, capture_output=capture)
    if check and r.returncode:
        sys.exit('%s failed:\n%s%s' % (' '.join(cmd), r.stdout or '', r.stderr or ''))
    return (r.stdout or '').strip() if capture else ''


def ok(*cmd):
    return subprocess.run(cmd, capture_output=True).returncode == 0


def out(**kv):
    for k, v in kv.items():
        print('%s=%s' % (k, v))


def parse(v):
    m = re.match(r'^v?(\d+)\.(\d+)\.(\d+)$', v or '')
    return tuple(int(x) for x in m.groups()) if m else None


def code_version():
    m = VERSION_LINE.search(open(TVWEB, encoding='utf-8').read())
    return m.group(1)


def set_code_version(v):
    src = open(TVWEB, encoding='utf-8').read()
    open(TVWEB, 'w', encoding='utf-8').write(VERSION_LINE.sub("var TVWEB_VERSION = '%s';" % v, src, count=1))


def auror_tags():
    """AUROR's own release tags here, newest first."""
    tags = [t for t in sh('git', 'tag', '-l', 'v*').split() if parse(t) and parse(t)[2] >= FIRST_BUILD]
    return sorted(tags, key=parse, reverse=True)


def latest_upstream():
    # A given tag instead, for a run by hand or a dry run here.
    if os.environ.get('AUROR_GLASSHOUSE_TAG'):
        return os.environ['AUROR_GLASSHOUSE_TAG'], ''
    r = json.loads(sh('gh', 'api', 'repos/%s/releases/latest' % UPSTREAM))
    return r['tag_name'], r.get('body') or ''


def resolve_version_conflicts(path):
    """Takes Glasshouse's side of conflicts that are only the version line; False if any other is left."""
    lines = open(path, encoding='utf-8').read().split('\n')
    res, i = [], 0
    while i < len(lines):
        if not lines[i].startswith('<<<<<<< '):
            res.append(lines[i])
            i += 1
            continue
        ours, theirs, j = [], [], i + 1
        while not lines[j].startswith('======='):
            ours.append(lines[j])
            j += 1
        j += 1
        while not lines[j].startswith('>>>>>>> '):
            theirs.append(lines[j])
            j += 1
        only_version = (len(ours) == 1 and len(theirs) == 1 and
                        VERSION_LINE.match(ours[0]) and VERSION_LINE.match(theirs[0]))
        if not only_version:
            return False
        res.extend(theirs)
        i = j + 1
    open(path, 'w', encoding='utf-8').write('\n'.join(res))
    return True


def sync():
    tag, body = latest_upstream()
    sh('git', 'fetch', '--no-tags', 'https://github.com/%s.git' % UPSTREAM,
       'refs/tags/%s:refs/glasshouse/%s' % (tag, tag))
    ref = 'refs/glasshouse/' + tag
    if ok('git', 'merge-base', '--is-ancestor', ref, 'HEAD'):
        return out(sync='current', glasshouse=tag)
    merged = ok('git', 'merge', '--no-ff', '--no-edit', '-m', 'Merge Glasshouse %s' % tag, ref)
    if not merged:
        conflicted = sh('git', 'diff', '--name-only', '--diff-filter=U').split()
        if conflicted == [TVWEB] and resolve_version_conflicts(TVWEB):
            sh('git', 'add', TVWEB)
            sh('git', 'commit', '--no-edit')
            merged = True
        else:
            sh('git', 'merge', '--abort')
            open_conflict_pr(tag, ref, conflicted)
            return out(sync='conflict', glasshouse=tag)
    os.makedirs('dist', exist_ok=True)
    with open('dist/glasshouse-notes.md', 'w', encoding='utf-8') as f:
        f.write(body)
    out(sync='merged', glasshouse=tag)


def open_conflict_pr(tag, ref, files):
    branch = 'sync/glasshouse-' + tag
    if DRY:
        print('would open a pull request for %s: %s' % (tag, ', '.join(files)), file=sys.stderr)
        return
    sh('git', 'push', '--force', 'origin', '%s:refs/heads/%s' % (ref, branch))
    if sh('gh', 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number', '--jq', 'length') != '0':
        return
    body = ('Glasshouse %s does not merge into main on its own: these files changed on both sides.\n\n%s\n\n'
            'Merge it by hand into main, keeping AUROR\'s changes. Once main has it, the next run publishes '
            'an AUROR release.' % (tag, '\n'.join('- `%s`' % f for f in files)))
    sh('gh', 'pr', 'create', '--base', 'main', '--head', branch, '--title', 'Merge Glasshouse %s' % tag, '--body', body)


def next_version(code, last):
    c = parse(code)
    if not last:
        return code if c[2] >= FIRST_BUILD else '%d.%d.%d' % (c[0], c[1], FIRST_BUILD)
    l = parse(last)
    if c[2] >= FIRST_BUILD and c > l:
        return code                      # set by hand in a pull request
    if c[:2] > l[:2]:
        return '%d.%d.%d' % (c[0], c[1], FIRST_BUILD)
    return '%d.%d.%d' % (l[0], l[1], l[2] + 1)


def version():
    tags = auror_tags()
    last = tags[0] if tags else None
    if last and ok('git', 'diff', '--quiet', last, 'HEAD', '--', 'server'):
        return out(release='none', version=last.lstrip('v'))
    nxt = next_version(code_version(), last.lstrip('v') if last else None)
    if nxt != code_version():
        set_code_version(nxt)
        sh('git', 'commit', '-q', '-m', 'AUROR v%s' % nxt, '--', TVWEB)
    out(release='yes', version=nxt, previous=(last or '').lstrip('v'))


def notes():
    """A summary for people on the sofa above "## Details", which the TV's updater shows."""
    ver = code_version()
    tags = auror_tags()
    prev = next((t for t in tags if t.lstrip('v') != ver), None)
    rng = '%s..HEAD' % prev if prev else 'HEAD'
    # Glasshouse's own commits are its release's to describe, not AUROR's.
    ok('git', 'fetch', '-q', '--no-tags', 'https://github.com/%s.git' % UPSTREAM, 'refs/tags/v*:refs/glasshouse/v*')
    subjects = [s for s in sh('git', 'log', '--no-merges', '--format=%s', rng, '--not', '--glob=refs/glasshouse/*',
                              '--', 'server').split('\n')
                if s and not s.startswith('AUROR v')]
    glass = ''
    if os.path.exists('dist/glasshouse-notes.md'):
        glass = open('dist/glasshouse-notes.md', encoding='utf-8').read()
    m = re.search(r'^##[ \t]+Details[ \t]*$', glass, re.M)
    glass_summary = (glass[:m.start()] if m else '').strip()
    merged = re.findall(r'^Merge Glasshouse (v[\d.]+)$', sh('git', 'log', '--merges', '--format=%s', rng), re.M)
    summary = []
    if merged:
        summary.append('Glasshouse %s, with AUROR on top.' % merged[0])
        if glass_summary:
            summary.append(glass_summary)
    if subjects and not merged:
        summary.append('AUROR: ' + '; '.join(subjects[:3]) + ('; and more.' if len(subjects) > 3 else '.'))
    elif subjects:
        summary.append('Also from AUROR: ' + '; '.join(subjects[:3]) + '.')
    if not summary:
        summary.append('AUROR v%s.' % ver)
    details = ['## Details', '']
    details += ['- %s' % s for s in subjects] or ['- Glasshouse merged; no AUROR change.']
    os.makedirs('dist', exist_ok=True)
    with open('dist/notes.md', 'w', encoding='utf-8') as f:
        f.write('\n\n'.join(summary) + '\n\n' + '\n'.join(details) + '\n')
    out(notes='dist/notes.md')


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd not in ('sync', 'version', 'notes'):
        sys.exit(__doc__)
    {'sync': sync, 'version': version, 'notes': notes}[cmd]()
