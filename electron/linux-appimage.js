const { app, dialog } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ID = 'com.sillygoose.tool';
const APP_NAME = 'SillyGoose Tool';
const PRODUCT_NAME = 'SillyGooseTool';
const APPIMAGE_NAME = `${PRODUCT_NAME}.AppImage`;
const APPIMAGE_ARGS = ['--no-sandbox'];

function getXdgPath(envName, fallback) {
  const configured = process.env[envName];
  if (configured && path.isAbsolute(configured)) return configured;
  return path.join(os.homedir(), fallback);
}

function getInstallPaths() {
  const dataHome = getXdgPath('XDG_DATA_HOME', '.local/share');
  const installDir = path.join(dataHome, PRODUCT_NAME);
  return {
    dataHome,
    installDir,
    appImagePath: path.join(installDir, APPIMAGE_NAME),
    desktopDir: path.join(dataHome, 'applications'),
    desktopPath: path.join(dataHome, 'applications', `${APP_ID}.desktop`),
    iconThemeDir: path.join(dataHome, 'icons', 'hicolor'),
    iconDir: path.join(dataHome, 'icons', 'hicolor', '256x256', 'apps'),
    iconPath: path.join(dataHome, 'icons', 'hicolor', '256x256', 'apps', `${APP_ID}.png`)
  };
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function quoteDesktopExecArg(value) {
  return `"${String(value).replace(/(["\\`$])/g, '\\$1')}"`;
}

function buildDesktopEntry(appImagePath) {
  const execArgs = APPIMAGE_ARGS.join(' ');
  return [
    '[Desktop Entry]',
    'Version=1.0',
    'Type=Application',
    `Name=${APP_NAME}`,
    'Comment=SillyGoose Configuration and Flight Tool',
    `Exec=${quoteDesktopExecArg(appImagePath)} ${execArgs}`,
    `Icon=${APP_ID}`,
    'Terminal=false',
    'Categories=Utility;',
    'StartupNotify=true',
    `StartupWMClass=${PRODUCT_NAME}`
  ].join('\n') + '\n';
}

async function writeTextFileIfChanged(filePath, text, mode) {
  try {
    if ((await fs.promises.readFile(filePath, 'utf8')) === text) return false;
  } catch {
    /* missing/unreadable files are rewritten below */
  }

  await fs.promises.writeFile(filePath, text, { encoding: 'utf8', mode });
  await fs.promises.chmod(filePath, mode);
  return true;
}

async function writeBinaryFileIfChanged(filePath, bytes, mode) {
  try {
    const existing = await fs.promises.readFile(filePath);
    if (existing.equals(bytes)) return false;
  } catch {
    /* missing/unreadable files are rewritten below */
  }

  await fs.promises.writeFile(filePath, bytes, { mode });
  await fs.promises.chmod(filePath, mode);
  return true;
}

async function writeDesktopIntegration(paths, assetRoot) {
  await fs.promises.mkdir(paths.desktopDir, { recursive: true });
  await fs.promises.mkdir(paths.iconDir, { recursive: true });

  const iconBytes = await fs.promises.readFile(path.join(assetRoot, 'icon.png'));
  const iconChanged = await writeBinaryFileIfChanged(paths.iconPath, iconBytes, 0o644);
  const desktopChanged = await writeTextFileIfChanged(
    paths.desktopPath,
    buildDesktopEntry(paths.appImagePath),
    0o644
  );

  if (desktopChanged) execFile('update-desktop-database', [paths.desktopDir], () => {});
  if (iconChanged) execFile('gtk-update-icon-cache', ['-q', paths.iconThemeDir], () => {});
}

async function installCurrentAppImage(currentAppImage, installedAppImage) {
  await fs.promises.mkdir(path.dirname(installedAppImage), { recursive: true });

  const tmpPath = `${installedAppImage}.tmp-${process.pid}`;
  await fs.promises.copyFile(currentAppImage, tmpPath);
  await fs.promises.chmod(tmpPath, 0o755);
  await fs.promises.rename(tmpPath, installedAppImage);
  await fs.promises.chmod(installedAppImage, 0o755);
}

function launchInstalledAppImage(appImagePath) {
  const env = { ...process.env };
  delete env.APPIMAGE;
  delete env.APPDIR;
  delete env.ARGV0;

  const child = spawn(appImagePath, APPIMAGE_ARGS, {
    detached: true,
    stdio: 'ignore',
    env
  });
  child.unref();
}

async function ensureLinuxAppImageIntegration(assetRoot) {
  if (process.platform !== 'linux' || !app.isPackaged || !process.env.APPIMAGE) {
    return false;
  }

  const currentAppImage = path.resolve(process.env.APPIMAGE);
  const paths = getInstallPaths();

  if (samePath(currentAppImage, paths.appImagePath)) {
    await writeDesktopIntegration(paths, assetRoot);
    return false;
  }

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Install and relaunch', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: `Install ${APP_NAME}`,
    message: `Install ${APP_NAME} for this user?`,
    detail:
      `This copies the AppImage to:\n${paths.appImagePath}\n\n` +
      'It also adds an app launcher with the SillyGoose icon. Future updates will run from this stable location instead of wherever the AppImage was downloaded.'
  });

  if (response !== 0) return false;

  try {
    await installCurrentAppImage(currentAppImage, paths.appImagePath);
    await writeDesktopIntegration(paths, assetRoot);
    launchInstalledAppImage(paths.appImagePath);
    app.quit();
    return true;
  } catch (err) {
    dialog.showErrorBox(
      `Could not install ${APP_NAME}`,
      err && err.message ? err.message : String(err)
    );
    return false;
  }
}

module.exports = {
  APP_ID,
  APP_NAME,
  PRODUCT_NAME,
  ensureLinuxAppImageIntegration
};
