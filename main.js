const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 850,
        icon: path.join(__dirname, 'Logo simple glasses.ico'), // Add this line
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false
        }
    });

    // --- NATIVE SELECTION DIALOG ---
    win.webContents.session.on('select-serial-port', async (event, portList, webContents, callback) => {
        // 1. Prevent Electron from automatically picking a port
        event.preventDefault();

        if (portList && portList.length > 0) {
            // 2. Format the list of ports for the user
            const options = portList.map(p => `${p.displayName || 'Unknown Device'} (${p.portId})`);

            // 3. Show a native Windows/Mac/Linux message box with buttons
            const result = await dialog.showMessageBox(win, {
                type: 'question',
                buttons: [...options, 'Cancel'],
                defaultId: 0,
                title: 'Select Serial Device',
                message: 'Multiple devices found. Please select your SillyGoose board:',
                cancelId: options.length // The 'Cancel' button index
            });

            // 4. Return the selected portId to the Serial API
            if (result.response < options.length) {
                callback(portList[result.response].portId);
            } else {
                callback(''); // User clicked Cancel
            }
        } else {
            dialog.showErrorBox('No Devices Found', 'Please plug in your SillyGoose board and try again.');
            callback('');
        }
    });

    // --- PERMISSIONS (Required for Serial to work) ---
    win.webContents.session.setPermissionCheckHandler((webContents, permission) => {
        return permission === 'serial';
    });

    win.webContents.session.setDevicePermissionHandler((details) => {
        return details.deviceType === 'serial';
    });

    win.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});