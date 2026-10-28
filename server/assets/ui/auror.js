// The Home tab's AUROR section: what Glasshouse Home's settings on the TV
// change, from a browser. The pages for photos and for linking Immich and Home Assistant are the
// phone's own, opened in a new tab with a code from the server.

const aurorState = { net: null, sleep: null, ssh: null, gallery: null, albums: null, busy: '' };
const AUROR_SLEEP_STEPS = [0, 30, 60, 90, 120];

async function aurorGet(path) {
  try { return await homeGet(path); } catch (e) { return null; }
}

async function loadAuror() {
  if (!q('auror-sec') || !homeStatus || !homeStatus.enabled) return;
  const [net, sleep, ssh, gallery] = await Promise.all([
    aurorGet('/api/home/network'), aurorGet('/api/home/sleep'), aurorGet('/api/home/ssh'), aurorGet('/api/home/gallery')
  ]);
  Object.assign(aurorState, { net, sleep, ssh, gallery });
  const im = homeCat && homeCat.immich;
  if (im && im.configured && !aurorState.albums) {
    const r = await aurorGet('/api/home/immich/albums');
    aurorState.albums = r ? r.albums : [];
  }
  renderAuror();
}

function aurorOnOff(id, on, busy) {
  updateToggle(id, { cls: on ? 'good' : 'idle', label: busy ? t('auror.switching', 'Switching…') : on ? t('common.on', 'On') : t('common.off', 'Off'), on: on, disabled: !!busy });
}

function renderAuror() {
  const look = (homeLayout && homeLayout.look) || {};
  const name = q('auror-name');
  if (name && document.activeElement !== name) name.value = look.name || '';

  const net = aurorState.net;
  q('auror-net').textContent = !net ? '—'
    : net.kind === 'none' ? t('auror.netNone', 'No network')
    : (net.kind === 'wifi' ? 'Wi-Fi' + (net.ssid ? ' “' + net.ssid + '”' : '') : t('auror.netWired', 'Cable')) + ' · ' +
      (net.state === 'online' ? t('auror.netOnline', 'online') : t('auror.netLimited', 'connected, but no internet')) + (net.ip ? ' · ' + net.ip : '');

  const sleep = aurorState.sleep, left = sleep && sleep.minutes ? sleep.minutes : 0;
  q('auror-sleep-state').textContent = left
    ? t('auror.sleepLeft', 'The TV switches off in {n} min.', { n: left })
    : t('auror.sleepOff', 'Off. Set, it goes on while an app is in front, and a minute before the TV says so.');
  const sel = q('auror-sleep');
  sel.innerHTML = AUROR_SLEEP_STEPS.map(m => '<option value="' + m + '">' +
    esc(m ? t('auror.minutes', '{n} min', { n: m }) : t('common.off', 'Off')) + '</option>').join('') +
    (left && AUROR_SLEEP_STEPS.indexOf(left) === -1 ? '<option value="' + left + '">' + esc(t('auror.minutes', '{n} min', { n: left })) + '</option>' : '');
  sel.value = String(left);

  const g = aurorState.gallery;
  const modes = { off: t('auror.photosOff', 'no photo, Glasshouse’s wallpapers'), one: t('auror.photosOne', 'one photo'), rotate: t('auror.photosRotate', 'all, in turn') };
  q('auror-photos-state').textContent = g
    ? t('auror.photosState', '{n} of {max} photos on the TV · behind Home: {mode}', { n: g.count, max: g.max, mode: modes[g.mode] || g.mode })
    : '—';

  const im = (homeCat && homeCat.immich) || { configured: false };
  q('auror-immich-state').textContent = im.configured
    ? t('auror.immichLinked', 'Linked to {server}', { server: im.server }) + (im.user ? ' · ' + im.user : '')
    : t('auror.immichNone', 'Not linked. Link opens the page that takes the server’s address and an API key.');
  updateToggle('auror-immich', { cls: im.configured ? 'good' : 'idle', label: im.configured ? t('auror.unlink', 'Unlink') : t('auror.link', 'Link') });
  q('auror-saver-row').hidden = !im.configured;
  q('auror-memories-row').hidden = !im.configured;
  if (im.configured) {
    const album = q('auror-saver-album');
    album.innerHTML = '<option value="">' + esc(t('auror.library', 'Whole library, at random')) + '</option>' +
      (aurorState.albums || []).map(a => '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>').join('');
    album.value = im.saverAlbum || '';
    aurorOnOff('auror-memories', !look.shelf || look.shelf.immich !== false);
  }

  const ha = (homeCat && homeCat.ha) || { configured: false };
  q('auror-ha-state').textContent = ha.configured
    ? t('auror.immichLinked', 'Linked to {server}', { server: ha.server }) + (ha.place ? ' · ' + ha.place : '')
    : t('auror.haNone', 'Not linked. Link opens the page that takes the address and a long-lived access token.');
  updateToggle('auror-ha', { cls: ha.configured ? 'good' : 'idle', label: ha.configured ? t('auror.unlink', 'Unlink') : t('auror.link', 'Link') });
  q('auror-ha-choose-row').hidden = !ha.configured;
  q('auror-ha-shelf-row').hidden = !ha.configured;
  if (ha.configured) {
    q('auror-ha-chosen').textContent = ha.chosen === null || ha.chosen === undefined
      ? t('auror.haFirstPick', 'A first pick: the heating, lights, covers, scenes, cameras and a few sensors. Choose opens the page with all of them.')
      : t('auror.haChosen', '{n} entities chosen. Choose opens the page with all of them.', { n: ha.chosen });
    aurorOnOff('auror-ha-shelf', !look.shelf || look.shelf.ha !== false);
  }

  const ssh = aurorState.ssh;
  q('auror-ssh-state').textContent = !ssh ? '—'
    : (ssh.running ? t('auror.sshListening', 'Listening on port 22') : t('auror.sshStopped', 'Not running')) +
      (ssh.passwordNow ? ' · ' + t('auror.sshPassword', 'the root password lets in: add a key in the Server tab to switch it off') : ssh.keys ? ' · ' + t('auror.sshKeys', 'keys only') : '') +
      (aurorState.net && aurorState.net.ip ? ' · root@' + aurorState.net.ip : '');
  aurorOnOff('auror-ssh', !!(ssh && ssh.enabled), aurorState.busy === 'ssh');
}

async function aurorSaveName() {
  const btn = q('auror-name-save');
  try {
    const r = await homePost('/api/home/look', { name: q('auror-name').value });
    homeLayout = r.layout;
    btn.textContent = t('auror.saved', 'Saved');
    setTimeout(() => { btn.textContent = t('auror.save', 'Save'); }, 1600);
  } catch (e) { showErr(e.message); }
}

async function aurorSetSleep(value) {
  try { aurorState.sleep = await homePost('/api/home/sleep', { minutes: +value }); } catch (e) { showErr(e.message); }
  renderAuror();
}

// The window opens at the click, so a popup blocker lets it through; its page comes once the code is in.
async function aurorOpenPage(path) {
  const w = window.open('', '_blank');
  try {
    const r = await homePost(path, {});
    if (w) w.location = r.url; else location.href = r.url;
  } catch (e) {
    if (w) w.close();
    showErr(e.message);
  }
}

function aurorOpenPhotos() { aurorOpenPage('/api/home/gallery/pair'); }

async function aurorImmich() {
  const im = homeCat && homeCat.immich;
  if (!im || !im.configured) return aurorOpenPage('/api/home/immich/pair');
  if (!confirm(t('auror.unlinkConfirm', 'Unlink Immich? The key is removed from the TV, and the Immich tile from the row.'))) return;
  try {
    await homePost('/api/home/immich/forget', {});
    aurorState.albums = null;
    loadHome();
  } catch (e) { showErr(e.message); }
}

async function aurorSaverAlbum(id) {
  try { homeCat.immich = await homePost('/api/home/immich/saver', { album: id || null }); } catch (e) { showErr(e.message); }
  renderAuror();
}

async function aurorMemories() {
  const look = (homeLayout && homeLayout.look) || {};
  const on = !look.shelf || look.shelf.immich !== false;
  try {
    const r = await homePost('/api/home/look', { shelf: { immich: !on } });
    homeLayout = r.layout;
  } catch (e) { showErr(e.message); }
  renderAuror();
}

async function aurorHa() {
  const ha = homeCat && homeCat.ha;
  if (!ha || !ha.configured) return aurorOpenPage('/api/home/ha/pair');
  if (!confirm(t('auror.haUnlinkConfirm', 'Unlink Home Assistant? The token is removed from the TV, and the Home Assistant tile from the row.'))) return;
  try {
    await homePost('/api/home/ha/forget', {});
    loadHome();
  } catch (e) { showErr(e.message); }
}

async function aurorHaShelf() {
  const look = (homeLayout && homeLayout.look) || {};
  const on = !look.shelf || look.shelf.ha !== false;
  try {
    const r = await homePost('/api/home/look', { shelf: { ha: !on } });
    homeLayout = r.layout;
  } catch (e) { showErr(e.message); }
  renderAuror();
}

async function aurorSsh() {
  const ssh = aurorState.ssh;
  if (!ssh || aurorState.busy) return;
  aurorState.busy = 'ssh';
  renderAuror();
  try { aurorState.ssh = await homePost('/api/home/ssh', { on: !ssh.enabled }); } catch (e) { showErr(e.message); }
  aurorState.busy = '';
  renderAuror();
}
