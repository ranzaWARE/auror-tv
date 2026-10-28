#!/usr/bin/env python3
"""
AUROR's repository for the Homebrew Channel: one package, AUROR's build of
Glasshouse, under Glasshouse's own app id, so the Homebrew Channel installs it
over Glasshouse and offers each release after.

    ./scripts/auror-hbc-repo.py site/hbc.json [--manifest file]

The latest release's manifest is put in the listing, as the Homebrew Channel's
own repository does, so its app reads the version without asking GitHub; its
ipkUrl is made absolute to that release, so a listing a release behind still
installs. Without a manifest (none given and GitHub not answering) the listing
names only the manifest's URL, which the Homebrew Channel then reads itself.
"""
import json
import os
import sys
import urllib.request

APP_ID = 'io.github.rorygallagher2024.lg-webos-dashboard'
REPO = 'https://github.com/ranzaWARE/auror-tv'
SITE = 'https://ranzaware.github.io/auror-tv/'
MANIFEST_URL = REPO + '/releases/latest/download/' + APP_ID + '.manifest.json'
TITLE = 'AUROR TV'
# Shown by the Homebrew Channel to AUROR's users, who read Italian.
DESCRIPTION = 'Glasshouse con la Home di AUROR, in italiano. Si installa sopra Glasshouse e ne tiene le impostazioni.'


def latest_manifest(path):
    if path:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    try:
        with urllib.request.urlopen(MANIFEST_URL, timeout=30) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception as e:  # noqa: BLE001 - any failure leaves the listing without it
        print('no manifest from GitHub (%s): the listing names its URL only' % e, file=sys.stderr)
        return None


def main():
    args = sys.argv[1:]
    if not args or args[0].startswith('-'):
        sys.exit(__doc__.strip().split('\n\n')[1])
    out = args[0]
    given = args[args.index('--manifest') + 1] if '--manifest' in args else None
    manifest = latest_manifest(given)
    if manifest is not None:
        ver, ipk = str(manifest.get('version', '')), str(manifest.get('ipkUrl', ''))
        sha = str((manifest.get('ipkHash') or {}).get('sha256', ''))
        if manifest.get('id') != APP_ID or not ver or not ipk.endswith('.ipk') or len(sha) != 64:
            sys.exit('the release manifest is not one for %s' % APP_ID)
        if '/' not in ipk:
            manifest['ipkUrl'] = '%s/releases/download/v%s/%s' % (REPO, ver, ipk)
        manifest.update({'title': TITLE, 'appDescription': DESCRIPTION, 'sourceUrl': REPO,
                         'iconUri': SITE + 'logo/auror-512.png'})
    package = {'id': APP_ID, 'title': TITLE, 'iconUri': SITE + 'logo/auror-512.png',
               'manifestUrl': MANIFEST_URL, 'shortDescription': DESCRIPTION}
    if manifest is not None:
        package['manifest'] = manifest
    listing = {'paging': {'page': 1, 'count': 1, 'maxPage': 1, 'itemsTotal': 1, 'prevUrl': None, 'nextUrl': None},
               'packages': [package]}
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(listing, f, indent=2)
        f.write('\n')
    print('%s: %s %s' % (out, TITLE, manifest['version'] if manifest else '(version read from the release)'))


if __name__ == '__main__':
    main()
