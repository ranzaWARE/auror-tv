# Home

> [!NOTE]
> **Experimental (webOS 9 & 10):** Glasshouse Home replaces LG's built-in launcher when pressing **Home** or **Back** on the remote, or when the TV turns on. It is available on webOS 9 and 10 (and on webOS 11 when `"allowExperimentalHome": true` is set in `config.json`), and requires the dashboard server on port `8080`.

![Glasshouse Home on an OLED55G36LA (webOS 9.2): clock and the Apps, Inputs and Channels rows over an uploaded afternoon wallpaper](../screenshots/home.jpg)

## What is on screen

Glasshouse Home displays a Top Shelf over up to three rows (any row with no visible items is automatically hidden). The Top Shelf shows the focused tile, fading in as the focus moves:

* **Jellyfin**: Continue watching, or Recently added when nothing is under way, or that the server is not answering. It is linked from a phone, in **Settings › Jellyfin** (below).
* **Glasshouse**: the SoC temperature, CPU, memory in use and Wi-Fi signal, from `/api/stats`, read again every 10 s while it has the focus.
* **An HDMI input**: the name of the device on it.
* **Any other app**: its colours as a glow across the shelf with its symbol large and faint, its logo and name, and for well-known apps a line saying what the app is. Jellyfin with nothing to show, and LG's Home, look the same.

Jellyfin's and Glasshouse's are asked for only once the focus rests on the tile. App tiles are 16:9 colour banners that show their name only when focused: well-known apps have their logo in white on the brand's colour, from [Simple Icons](https://github.com/simple-icons/simple-icons) (CC0-1.0, the logos remaining their owners' trademarks), and any other app its own icon on a colour. The clock and date sit at the top right with two buttons, reached with **Up**: the theme switch and the settings.

The theme is light from 06:00 to 17:00 and dark from 17:00. Switching it by hand holds until the next of those changes. Against burn-in, the whole page wanders a few pixels, slowly and continuously, so no text stays on the same pixels. Every few minutes Mimus runs along the bottom or Quetza flies across the top.

### Settings on the TV

The gear opens Glasshouse Home's own settings, worked with the remote:

* **Look**: the theme (automatic, light or dark), the [AUROR screen saver](screen-savers.md) and its brightness, and Mimus and Quetza.
* **Top Shelf**: what Jellyfin, Glasshouse and the HDMI inputs show there.
* **Tiles**: which apps show. LG's Home always does.
* **Jellyfin**: the server and user linked, and a QR code. Scanned with a phone on the same network, it opens a page for the server's address and an API key (Jellyfin's **Dashboard › API Keys**), so neither is typed with the remote. The code lasts ten minutes and links once; the details are tried before they are kept, and the key is kept on the TV only, in `/var/lib/tvweb/jellyfin.json`.
* **Glasshouse**: opens Glasshouse's TV app, for everything else.

<div class="grid cards" markdown>

-   **Apps**

    ---

    Every app from LG's launcher. LG's promotional tiles (LG Channels, Sports, Always Ready, Alexa, Camera) and LG's **Notifications** and **Search** start hidden, and apps hidden under [Hide home screen system apps](apps.md) stay hidden here. An always-present **LG Home** tile comes at the end.

-   **Inputs & HDMI-CEC devices**

    ---

    Only the HDMI ports with something plugged in, with separate tiles for connected HDMI-CEC devices (for example, *"HDMI 2, through STEREO 70s"*). Selecting a CEC tile wakes the device and switches receivers to that source. With nothing plugged in, the row is left out.

-   **Channels**

    ---

    Favourite live TV channels added from the dashboard or TV app, showing the current broadcast programme from the TV guide when available.

-   **Recent apps (`Back` button)**

    ---

    Pressing **Back** on Glasshouse Home opens a strip of recently used apps with live snapshots. Press **OK** to switch to an app, **Down** to close a single app, or **Up** for **Close all**.

-   **Picture details plate**

    ---

    When **Picture details** is switched on, a badge at the bottom right of the Top Shelf shows the active picture preset, OLED light / backlight level, and signal format — live HDMI resolution, refresh rate, chroma, bit depth, HDR format, and VRR, or the last video format played in an app.

-   **Colours & themes**

    ---

    Six built-in colour presets plus custom **Text** and **Accent** colour pickers in the web dashboard (or preset cycling in the TV app). The accent colour highlights the focused tile and the last active source.

</div>

## Wallpapers

By default, Glasshouse Home uses AUROR's plain dark or light background (and leaves the TV's [screen saver](screen-savers.md) untouched). Custom wallpapers can be uploaded for four times of day (**Morning** 06:00, **Afternoon** 11:00, **Evening** 17:00, **Night** 21:00):

* Select a JPEG, PNG, or WebP image (up to 25 MB) in the web dashboard and click **Upload image**. The browser scales it to 1920 × 1080 JPEG before saving it to `/var/lib/tvweb/home-wallpaper-uploads` on the TV.
* **Remove uploaded images** restores the plain background.

=== "Afternoon wallpaper"

    ![Glasshouse Home with an uploaded afternoon wallpaper](../screenshots/home.jpg)

=== "Evening wallpaper"

    ![Glasshouse Home with an uploaded evening wallpaper](../screenshots/home-evening.jpg)

=== "Pure black (default)"

    ![Glasshouse Home on its default pure black background](../screenshots/home-black.jpg)

=== "Upload controls"

    ![Personal wallpapers uploaded for all four time-of-day slots](../screenshots/home-wallpaper-upload.png)

## Switching it on and off

Click **Use Glasshouse Home** (and confirm on the second press) in the web dashboard's **Home** tab or the TV app's **Home** section. Glasshouse Home is mounted over LG's launcher without modifying the root filesystem. Clicking **Use LG Home** (or running `tvwebctl restore-glasshouse-home` over SSH) restores LG's launcher within a few seconds.

* **Reaching LG's Home without turning Glasshouse Home off:**
  * Select the **LG Home** tile at the end of the Apps row.
  * Hold the remote's **Home** button for 1 second (a short press on LG's Home returns to Glasshouse Home).
  * Stop the Glasshouse server: if Glasshouse Home stops answering or the server is stopped/uninstalled, LG's Home automatically takes its place back.
* **Cold boot & standby:** With Quick Start+ (Active Standby) on, Glasshouse Home opens immediately on wake. On a cold boot (Quick Start+ off), Glasshouse Home takes over about 25–40 seconds after power-on; pressing Home during startup keeps the TV on the current input with a brief notice until ready.
* **Hide LG's Home while the TV starts (webOS 9 optional setting):** Replaces LG's Home layout with a blank screen during the first seconds of a cold boot so LG's launcher never flashes on screen.

> [!WARNING]
> **If `Hide LG's Home while the TV starts` is enabled** and Glasshouse is removed manually without running `Use LG Home` or `tvwebctl restore-glasshouse-home` (for example, if a firmware update removes root), LG's Home will remain blank until its layout cache is cleared over SSH:
> ```sh
> rm -rf /mnt/lg/cmn_data/manifest /tmp/checkpoint/*com.webos.app.home* /mnt/lg/cmn_data/checkpoint/*com.webos.app.home* && reboot
> ```

## Arranging

Rows and tiles can be arranged from the **web dashboard**, the **TV app**, or **directly on Glasshouse Home**:

* **On the TV screen:** Hold **OK** on any tile to enter arrange mode. Use the D-pad (**Left/Right** to move a tile, **Up/Down** to reorder rows), **Back** to hide/show a tile or remove a channel, and the bottom bar for **Reset** and **Done**.
* **Row ordering (`Your order` vs `Last opened`):** Each row can be set to stay in a fixed custom order (**Your order**) or automatically move the most recently used app, input, or channel to the front (**Last opened**, keeping **LG Home** pinned at the end).
* **Adding and removing channels:** Apps and inputs are discovered automatically from the TV and toggled between shown and hidden; live TV channels are added by name or number under **Add channels** and removed when no longer needed.

=== "Arranging on the TV (hold OK)"

    ![Arranging on the TV: Sky News focused in the Channels row, with the bar for removing it, resetting and finishing](../screenshots/home-arrange.jpg)

=== "Web dashboard"

    ![The Home tab in the browser dashboard: the Channels row with its added channels, and Add channels below them](../screenshots/home-dashboard.png)

=== "TV app"

    ![The Home section of the TV app: inputs shown or hidden, channels removed with OK, and Add channels](../screenshots/home-tv-app.jpg)
