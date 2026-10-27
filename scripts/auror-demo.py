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


def page(src, dest, extra):
    with open(os.path.join(ASSETS, src), encoding='utf-8') as f:
        html = relative(f.read())
    # The demo's TV goes in first, before the page's own scripts ask it anything.
    first = html.index('<script')
    html = html[:first] + extra + html[first:]
    with open(dest, 'w', encoding='utf-8') as f:
        f.write(html)


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
    script = '<script src="demo/api.js"></script>\n'
    page('home.html', os.path.join(out, 'home.html'), script)
    page('jellyfin-phone.html', os.path.join(out, 'jellyfin.html'), script)
    page('search-phone.html', os.path.join(out, 'tmdb.html'), script)
    for name in ('index.html', 'saver.html'):
        shutil.copy(os.path.join(HERE, name), os.path.join(out, name))
    print('AUROR demo in ' + out)


if __name__ == '__main__':
    main()
