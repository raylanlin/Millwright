// src/main/index.ts
//
// Electron main-process entry point.

import './crash-log'; // ⚠️ MUST come before any business import, so the crash handler is registered first

import { app, BrowserWindow, shell, Menu } from 'electron';
import * as path from 'path';
import { crashLog } from './crash-log';
import { registerIpcHandlers, abortAllRequests } from './ipc/handlers';
import { getBridge } from './com/sw-bridge';
import { getSidecar } from './com/sw-sidecar';
import { SWHealthMonitor } from './com/health';
import { IpcChannels } from '../shared/ipc-channels';

const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;
let healthMonitor: SWHealthMonitor | null = null;

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function createMainWindow(): void {
  crashLog('createMainWindow start');
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1b1c20',
    title: 'SW Copilot',
    webPreferences: {
      preload: app.isPackaged
        ? path.join(app.getAppPath(), 'dist/preload/preload/index.js')
        : path.join(__dirname, '../../preload/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    crashLog('ready-to-show');
    mainWindow?.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    crashLog(`loading renderer: dist/renderer/index.html`);
    mainWindow.loadFile(path.join(app.getAppPath(), 'dist/renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startHealthMonitor(): void {
  const bridge = getBridge();
  healthMonitor = new SWHealthMonitor(
    bridge,
    (status) => {
      mainWindow?.webContents.send(IpcChannels.SW_STATUS, status);
    },
    5_000,
  );
  healthMonitor.start();
}

app.whenReady().then(async () => {
  crashLog(`app ready, electron ${process.versions.electron}`);

  try {
    crashLog('generators coverage check');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { checkCoverage } = require('./scripts/generators');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SW_TOOLS } = require('../shared/sw-tools');
    const cov = checkCoverage(SW_TOOLS);
    if (cov.missing.length > 0) {
      console.warn('[SW Copilot] generator coverage incomplete; missing:', cov.missing);
    }
    crashLog('generators ok');
  } catch (err) {
    crashLog(`generators error: ${err}`);
  }

  crashLog('register handlers');
  Menu.setApplicationMenu(null);

  try {
    registerIpcHandlers(getMainWindow);
    crashLog('handlers ok');
  } catch (err) {
    crashLog(`handlers FAILED: ${err}`);
    throw err;
  }

  createMainWindow();
  crashLog('window created');

  if (process.env.SKIP_SW_CONNECT !== 'true') {
    startHealthMonitor();
    getBridge().connect().catch(() => void 0);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  abortAllRequests();
  healthMonitor?.stop();
  getSidecar().stop(); // P3: stop the python sidecar process on quit
  getBridge().disconnect();
});
