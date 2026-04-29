// src/main/index.ts
//
// Electron 主进程入口

import { app, BrowserWindow, shell, Menu } from 'electron';
import * as path from 'path';
import { registerIpcHandlers, abortAllRequests } from './ipc/handlers';
import { getBridge } from './com/sw-bridge';
import { SWHealthMonitor } from './com/health';
import { IpcChannels } from '../shared/ipc-channels';

const isDev = process.env.NODE_ENV === 'development';

let mainWindow: BrowserWindow | null = null;
let healthMonitor: SWHealthMonitor | null = null;

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#1b1c20',
    title: 'SW Copilot',
    webPreferences: {
      // tsc rootDir=src 导致输出保留子目录结构:
      //   dist/main/main/index.js   (本文件)
      //   dist/preload/preload/index.js
      // 用 app.getAppPath() 做基准更可靠,打包后也不会断
      preload: app.isPackaged
        ? path.join(app.getAppPath(), 'dist/preload/preload/index.js')
        : path.join(__dirname, '../../preload/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload 需要用到 require('electron')
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // 新窗口交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
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
  // 启动时做一次生成器覆盖率自检,尽早暴露声明与实现不一致的问题。
  // 这个检查只读,不产生任何副作用,生产环境代价忽略不计。
  try {
    // 动态 require 避免在电子启动路径里引入循环依赖;失败不阻塞启动
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { checkCoverage } = require('./scripts/generators');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SW_TOOLS } = require('../shared/sw-tools');
    const cov = checkCoverage(SW_TOOLS);
    if (cov.missing.length > 0) {
      console.warn('[SW Copilot] 生成器覆盖率不全,缺少:', cov.missing);
    }
    if (cov.extra.length > 0) {
      console.warn('[SW Copilot] 注册表中有 SW_TOOLS 未声明的工具:', cov.extra);
    }
  } catch (err) {
    console.warn('[SW Copilot] 生成器自检失败:', err);
  }

  // 移除默认菜单栏 (File/Edit/View/Window/Help)
  Menu.setApplicationMenu(null);

  registerIpcHandlers(getMainWindow);
  createMainWindow();

  // SKIP_SW_CONNECT=true 时跳过 COM 连接和心跳，方便纯 UI 开发
  if (process.env.SKIP_SW_CONNECT !== 'true') {
    startHealthMonitor();

    // 启动时尝试自动连接一次 SolidWorks(非阻塞)
    getBridge()
      .connect()
      .catch(() => void 0);
  } else {
    console.info('[SW Copilot] SKIP_SW_CONNECT=true, 跳过 SolidWorks 连接');
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
  getBridge().disconnect();
});
