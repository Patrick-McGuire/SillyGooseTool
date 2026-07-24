# Notes for Claude Code

- After changing anything under `src/`, `electron/`, or `build.mjs`, rebuild the local
  standalone exe: `npm run build:local` (rebuilds `dist/index.html` then repackages
  `release/win-unpacked/SillyGoose Tool (Local).exe`).
- A Desktop shortcut ("SillyGoose Tool (Local)") points directly at that exe path, so
  it always launches whatever was last built there - no separate step needed to
  "install" it.
- This local build has its own distinct Windows AppUserModelID
  (`com.sillygoose.tool.local`, via `localAppId`/`localAppName`/`localProductName` in
  `--config.extraMetadata`), kept separate from the officially published GitHub
  release's identity (`com.sillygoose.tool`) so the two don't collide/group together
  on the taskbar.
- Kill any running `SillyGoose Tool (Local).exe` process before rebuilding - files in
  `release/win-unpacked/` are locked while it's running and `rm -rf release` /
  electron-builder will fail with EBUSY otherwise.
