# SillyGoose Tool

Single source of truth for the SillyGoose Configuration Tool — both the **web
app** (hosted on GitHub Pages) and the **desktop app** (Electron).

The app is a self-contained vanilla-JS single-page tool that talks to SillyGoose
flight computers over Web Serial. `build.mjs` assembles `src/` (app.js, app.css,
body.html, bundled Plotly + JSZip, logo) into one standalone `dist/index.html`.
Both targets use that same file: Electron loads it directly; the GitHub Action
publishes it to the Pages site.

## Layout

```
src/                  web app source (single source of truth)
build.mjs             assembles src/ -> dist/index.html (+ PWA manifest & SW)
make-icon.mjs         pads assets/icon.png to a square and writes assets/icon.ico
electron/             desktop wrapper (main process + serial picker modal)
assets/               desktop icon (icon.png source, icon.ico generated)
.github/workflows/    deploy-web.yml — publishes the build to GitHub Pages
```

## Develop

```bash
npm install
npm run build:web     # -> dist/index.html (open directly in a browser)
npm run start         # build + launch the Electron app
```

## Build the desktop app

```bash
npm run icon          # regenerate assets/icon.ico from assets/icon.png (only if the logo changed)
npm run dist          # NSIS installer in release/
npm run dist:linux    # AppImage in release/ (run this on Linux)
```

## Linux AppImage install behavior

The Linux release artifact is still a portable AppImage, but on first launch the
packaged app offers to install itself for the current user. Accepting that prompt:

- copies the AppImage to `~/.local/share/SillyGooseTool/SillyGooseTool.AppImage`
  (or `$XDG_DATA_HOME/SillyGooseTool/SillyGooseTool.AppImage` when
  `XDG_DATA_HOME` is set);
- creates an app launcher at
  `~/.local/share/applications/com.sillygoose.tool.desktop`;
- installs the logo at
  `~/.local/share/icons/hicolor/256x256/apps/com.sillygoose.tool.png`;
- relaunches from the installed copy.

That gives Linux desktops a searchable app entry with the SillyGoose icon, and
future AppImage updates run against the stable installed copy instead of the file
that happened to be in `Downloads`.

## Web deploy (GitHub Pages)

`https://patrick-mcguire.github.io/sillygoose/` is served from the
`Patrick-McGuire.github.io` repo. The `deploy-web.yml` Action builds `dist/` and
pushes `index.html` + PWA files into that repo's `sillygoose/` folder on every
push to `main` that touches `src/` or `build.mjs`.

**One-time setup:** create a fine-grained Personal Access Token with
*Contents: read and write* on the `Patrick-McGuire.github.io` repository, and add
it to this repo's secrets as `PAGES_DEPLOY_TOKEN`
(Settings → Secrets and variables → Actions).

## Serial device selection (desktop)

The Electron main process intercepts the serial chooser:

- **0 SillyGoose detected** → falls back to a chooser listing all serial ports
  (or an error if none are connected).
- **1 SillyGoose** → connects automatically, no prompt.
- **>1 SillyGoose** → shows the styled picker (`electron/serial-picker.html`).

SillyGoose boards are matched by Adafruit USB vendor id (`239a`) plus a product
name containing `SillyGoose`. In a plain browser, the native chooser is
pre-filtered to Adafruit devices (the most a browser allows).
