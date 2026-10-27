#!/usr/bin/env python3
"""
Builds the AUROR demo: Glasshouse Home's real view, with
scripts/auror-demo/api.js standing in for the TV, as static files for
GitHub Pages. docs-publish.yml runs it into the built site:

    ./scripts/auror-demo.py site/demo

Pages serves the demo below the site's root, so the pages' /assets/ paths
are made relative; everything else is the view as the TV shows it.
"""
import os
import re
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, 'server', 'assets')
HERE = os.path.join(ROOT, 'scripts', 'auror-demo')

# What the view and the phone page load, beside them as on the TV.
COPY = ['auror-home.css', 'i18n.js', 'qr.js', 'favicon.svg', 'fonts', 'banners', 'i18n',
        os.path.join('screensavers', 'auror')]

# Made-up shows for the Jellyfin shelf, the search and the posters.
POSTERS = [('Orbite basse', '#3a2a6e', '#0f6f8f'), ('Casa sul lago', '#1f4d3a', '#7a9a52'),
           ('Nebbia d’agosto', '#6b3a2a', '#c78a3b'), ('Il faro del nord', '#14324f', '#4f88b8'),
           ('Cronache di vetro', '#3d3d46', '#9aa3b5'), ('La valle lenta', '#5a2f48', '#c46b8a')]


def relative(text):
    """The pages' /assets/ and /api/ paths, made to work below the site's root."""
    text = re.sub(r'''(["'(])/assets/''', r'\1assets/', text)
    return text


def page(src, dest, extra, *swaps):
    with open(os.path.join(ASSETS, src), encoding='utf-8') as f:
        html = relative(f.read())
    for old, new in swaps:
        if old not in html:
            sys.exit('auror-demo: %s no longer has %s' % (src, old))
        html = html.replace(old, new)
    # The demo's TV goes in first, before the page's own scripts ask it anything.
    first = html.index('<script')
    html = html[:first] + extra + html[first:]
    with open(dest, 'w', encoding='utf-8') as f:
        f.write(html)


# Landscapes standing in for the owner's photos behind Home.
PHOTOS = [('#f6b26b', '#7a4b8f', '#3d2f5a', '#1d1a33', '#ffe3a3'), ('#9fd3e6', '#3b7ea1', '#2f5d50', '#173328', '#ffffff'),
          ('#c6e2b5', '#5f9c6a', '#2f6b3f', '#163821', '#fff7d6'), ('#0b1d3a', '#1f3b6e', '#18284a', '#0a1222', '#e8eefc')]


def photo(sky, low, hill, near, sun):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice">'
            '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="%s"/>'
            '<stop offset="1" stop-color="%s"/></linearGradient></defs>'
            '<rect width="1920" height="1080" fill="url(#s)"/>'
            '<circle cx="1380" cy="360" r="120" fill="%s" fill-opacity=".85"/>'
            '<path d="M0 700 C300 560 560 640 820 600 S1400 520 1920 640 V1080 H0Z" fill="%s"/>'
            '<path d="M0 860 C380 760 700 820 1020 780 S1600 740 1920 820 V1080 H0Z" fill="%s"/>'
            '</svg>\n') % (sky, low, sun, hill, near)


def poster(title, c1, c2):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 225">'
            '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="%s"/>'
            '<stop offset="1" stop-color="%s"/></linearGradient></defs>'
            '<rect width="400" height="225" fill="url(#g)"/>'
            '<circle cx="318" cy="64" r="34" fill="#fff" fill-opacity=".18"/>'
            '<text x="24" y="196" font-family="sans-serif" font-size="26" font-weight="600" fill="#fff" fill-opacity=".92">%s</text>'
            '</svg>\n') % (c1, c2, title)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'site/demo'
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(os.path.join(out, 'assets', 'screensavers'))
    os.makedirs(os.path.join(out, 'demo'))
    for item in COPY:
        src, dest = os.path.join(ASSETS, item), os.path.join(out, 'assets', item)
        if os.path.isdir(src):
            shutil.copytree(src, dest)
        else:
            shutil.copy(src, dest)
    css = os.path.join(out, 'assets', 'auror-home.css')
    with open(css, encoding='utf-8') as f:
        text = f.read().replace('url("/assets/fonts/', 'url("fonts/')
    with open(css, 'w', encoding='utf-8') as f:
        f.write(text)
    shutil.copy(os.path.join(HERE, 'api.js'), os.path.join(out, 'demo', 'api.js'))
    for i, p in enumerate(POSTERS):
        with open(os.path.join(out, 'demo', 'poster%d.svg' % i), 'w', encoding='utf-8') as f:
            f.write(poster(*p))
    for i, p in enumerate(PHOTOS):
        with open(os.path.join(out, 'demo', 'photo%d.svg' % i), 'w', encoding='utf-8') as f:
            f.write(photo(*p))
    script = '<script src="demo/api.js"></script>\n'
    # Images are not requests the demo's TV can answer: the photos are the files beside the page.
    page('home.html', os.path.join(out, 'home.html'), script,
         ('"/api/home/photo?id=\' + encodeURIComponent(g.shown) + \'&thumb=1"', '"demo/\' + g.shown + \'.svg"'))
    page('gallery-phone.html', os.path.join(out, 'photos.html'), script,
         ("'/photos/thumb?c=' + code + '&id=' + id", "'demo/' + id + '.svg'"))
    page('jellyfin-phone.html', os.path.join(out, 'jellyfin.html'), script)
    page('search-phone.html', os.path.join(out, 'tmdb.html'), script)
    for name in ('index.html', 'saver.html'):
        shutil.copy(os.path.join(HERE, name), os.path.join(out, name))
    print('AUROR demo in ' + out)


if __name__ == '__main__':
    main()
