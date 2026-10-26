# Ideas

Things considered for Glasshouse Home and left for later, with what was found
about them, so the next attempt starts from there.

## Spotify in the Top Shelf

What Spotify would show in the Top Shelf, the way Jellyfin shows Continue
watching: covers of what was played lately, and OK on one opens Spotify on
the TV and starts it there.

**What Spotify's Web API still gives an app in Development Mode**, after the
[February 2026 changes](https://developer.spotify.com/documentation/web-api/references/changes/february-2026):

- Recently played (`GET /me/player/recently-played`): tracks with their album
  or playlist, to show as covers. The closest to Continue watching.
- The user's own playlists (`GET /me/playlists`) and top tracks and artists
  (`GET /me/top/{type}`).
- Every player endpoint: what is playing, play, pause, next, previous, and
  starting a context on a device (`PUT /me/player/play`, Premium only).

Gone for such apps: Made for you, Daily Mix, new releases, browse categories
and recommendations, so real suggestions are not possible.

**Conditions** ([summary](https://www.itechguides.com/spotify-changes-developer-mode-api-to-require-premium-accounts-and-limit-test-users/)):
the owner creates a free app at developer.spotify.com and needs an active
Premium subscription; an app has at most five authorised users, and all of an
owner's apps share one request quota.

**Signing in from a phone.** Since April 2025 a redirect URI must be HTTPS or
a loopback literal (`http://127.0.0.1:PORT`), never a LAN address
([rules](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)).
A phone sent back to `127.0.0.1` lands on an error page. The way round it
without copying anything:

1. The settings show a QR code to the TV's page, as for Jellyfin.
2. The TV starts an authorization code flow with PKCE, keeping the verifier;
   `state` carries a one-time nonce and the TV's LAN address.
3. The redirect URI is a static page on the fork's GitHub Pages. It only
   reads `code` and `state` and sends the browser on to
   `http://<TV>/spotify/callback`, refusing any address that is not a private
   one.
4. The TV checks the nonce, exchanges the code with the verifier and keeps the
   refresh token, readable by root only. The code is useless without the
   verifier, which never leaves the TV.

**Playing on the TV.** OK on a cover launches LG's Spotify app, waits for it
to appear as a Connect device, and starts the context there. Whether webOS
keeps Spotify playing once Glasshouse Home is back in front is not known: to
be tried by starting a song in Spotify on the TV and pressing Home. If it
does, Home can start music and stay in front; if not, the app stays in front,
with a button to switch the screen off.

**Left out:** the TV as a Spotify Connect device in the background with no app
open. It needs librespot, which is unofficial, against Spotify's terms, and
untried with webOS's audio.
