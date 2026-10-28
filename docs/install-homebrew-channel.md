# Installing from the Homebrew Channel

AUROR has its own repository for the Homebrew Channel. In the Homebrew Channel, the gear, then **Add repository**, takes its address, `https://ranzaware.github.io/auror-tv/hbc.json`; back in the list, **AUROR TV** installs over Glasshouse, which keeps its settings, and the Homebrew Channel offers each AUROR release after. Glasshouse's own **Install app from a URL or file** refuses its own package, so AUROR cannot be installed from there.

1. Open the Homebrew Channel, find **Glasshouse**, and install it.
2. Open **Glasshouse** from the home screen. The first launch puts the server in place, which takes a few seconds.
3. Setup asks whether phones and computers on the network may use the dashboard, and whether to connect Home Assistant. Broker details are typed on a phone, which scans a code from the TV. Both can be changed later in the **Settings** tab.

An install from the Homebrew Channel differs from one made with `deploy.sh` in a few ways:

* It answers only on the TV itself until setup opens it to the network.
* Updates come through the Homebrew Channel. The **Server** tab still says when a release is out, and the server follows an updated app within a few minutes, without the app being opened.
* Uninstalling the app removes the server as well: see [Uninstalling](managing.md#uninstalling).
* Hiding built-in home-screen tiles is not offered, since it restarts the app manager during boot, which the Homebrew Channel asks its apps not to do.

An existing `deploy.sh` install is taken over in place, configuration and all, the first time the app is opened. Its old home-screen tile is removed.

[Installing with a computer](install.md) covers `deploy.sh`.
