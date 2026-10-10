const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('node:path');

const DEFAULT_URL = 'https://gmail.skyfirst.io.vn';
const targetUrl = process.env.SKY_FIRST_MAIL_URL || DEFAULT_URL;
let mainWindow;

function trustedOrigin() {
  try { return new URL(targetUrl).origin; }
  catch { return new URL(DEFAULT_URL).origin; }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 940,
    minHeight: 640,
    show: false,
    title: 'Sky First Mail',
    icon: path.join(__dirname, '..', 'public', 'app-icon.ico'),
    backgroundColor: '#073c9b',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: true
    }
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { const u = new URL(url); if (['https:', 'http:'].includes(u.protocol)) shell.openExternal(u.href); } catch {}
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const next = new URL(url);
      if (next.origin !== trustedOrigin()) {
        event.preventDefault();
        if (['https:', 'http:'].includes(next.protocol)) shell.openExternal(next.href).catch(() => {});
      }
    } catch { event.preventDefault(); }
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    try { if (new URL(url).origin !== trustedOrigin()) event.preventDefault(); }
    catch { event.preventDefault(); }
  });
  mainWindow.webContents.on('page-title-updated', event => { event.preventDefault(); mainWindow.setTitle('Sky First Mail'); });
  mainWindow.loadURL(targetUrl);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.setAppUserModelId('io.vn.skyfirst.mail');
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
