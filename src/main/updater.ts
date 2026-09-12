// src/main/updater.ts
//
// P129: in-app updates via electron-updater (NSIS target, GitHub Releases provider).
//
//   check    → electron-updater reads latest.yml from the GitHub release
//   download → only after the user clicks (autoDownload=false); blockmap differential
//   install  → quitAndInstall(): NSIS runs silently, then relaunches. installer.nsh's
//              customInit stops the old sidecar python.exe first, so the "file in use"
//              upgrade failure of the v0.2.x era cannot recur.
//
// Event shapes are kept identical to the P128 zip-updater so UpdateBanner is unchanged.
// Disabled when unpackaged, when not on Windows, or with MILLWRIGHT_NO_UPDATE=1.
// The zip artifact stays downloadable for people who prefer it; it simply never auto-updates.

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { autoUpdater, type UpdateInfo as EUInfo } from 'electron-updater';
import * as fs from 'fs';
import * as path from 'path';
import { IpcChannels } from '../shared/ipc-channels';

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15_000;
const RELEASES_URL = 'https://github.com/raylanlin/Millwright/releases';

export interface UpdateInfo {
  version: string;
  current: string;
  tag: string;
  url: string;
  notes: string;
  asset: { name: string; url: string; size: number } | null;
  publishedAt: string;
}

let win: () => BrowserWindow | null = () => null;
let timer: ReturnType<typeof setInterval> | null = null;
let latest: UpdateInfo | null = null;
let downloaded = false;
let busy = false;

const prefsPath = () => path.join(app.getPath('userData'), 'updater.json');
function loadPrefs(): { skipVersion?: string; lastCheck?: number } {
  try { return JSON.parse(fs.readFileSync(prefsPath(), 'utf8')); } catch { return {}; }
}
function savePrefs(p: { skipVersion?: string; lastCheck?: number }): void {
  try { fs.writeFileSync(prefsPath(), JSON.stringify(p)); } catch { /* best effort */ }
}

function emit(ev: any): void {
  win()?.webContents.send(IpcChannels.UPDATE_EVENT, ev);
}

export function enabled(): boolean {
  return app.isPackaged && process.platform === 'win32' && process.env.MILLWRIGHT_NO_UPDATE !== '1'
    // zip-extracted installs have no uninstaller registry entry → electron-updater's NSIS path cannot apply
    && fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall Millwright.exe'));
}

function toInfo(u: EUInfo): UpdateInfo {
  const file = (u.files || [])[0];
  const notes = Array.isArray(u.releaseNotes)
    ? u.releaseNotes.map((n) => (typeof n === 'string' ? n : n.note || '')).join('\n')
    : String(u.releaseNotes || '');
  return {
    version: u.version,
    current: app.getVersion(),
    tag: `v${u.version}`,
    url: `${RELEASES_URL}/tag/v${u.version}`,
    notes: notes.replace(/<[^>]+>/g, '').slice(0, 4000),
    asset: file ? { name: path.basename(file.url), url: file.url, size: Number(file.size) || 0 } : null,
    publishedAt: u.releaseDate || '',
  };
}

let manualCheck = false;

function wire(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;   // if the user never clicks "restart", the next quit applies it
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('update-available', (u) => {
    latest = toInfo(u);
    downloaded = false;
    const prefs = loadPrefs();
    savePrefs({ ...prefs, lastCheck: Date.now() });
    if (!manualCheck && prefs.skipVersion === u.version) return;
    emit({ type: 'available', info: latest });
  });
  autoUpdater.on('update-not-available', () => {
    latest = null;
    savePrefs({ ...loadPrefs(), lastCheck: Date.now() });
    emit({ type: 'none', current: app.getVersion() });
  });
  autoUpdater.on('download-progress', (p) => {
    emit({ type: 'progress', received: p.transferred, total: p.total, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (u) => {
    downloaded = true;
    busy = false;
    emit({ type: 'staged', version: u.version });
  });
  autoUpdater.on('error', (e) => {
    busy = false;
    emit({ type: 'error', message: e?.message || String(e) });
  });
}

export function initUpdater(getWindow: () => BrowserWindow | null): void {
  win = getWindow;

  ipcMain.handle(IpcChannels.APP_VERSION, () => ({
    version: app.getVersion(),
    updatesEnabled: enabled(),
    justUpdated: process.argv.includes('--updated') || wasJustUpdated(),
    updateFailed: null,
  }));

  ipcMain.handle(IpcChannels.UPDATE_CHECK, async () => {
    if (!enabled()) return { ok: false, error: 'updates are only available for the installed (Setup) build' };
    manualCheck = true;
    try {
      const r = await autoUpdater.checkForUpdates();
      return { ok: true, info: r?.updateInfo ? toInfo(r.updateInfo) : null };
    } catch (e) {
      return { ok: false, error: msg(e) };
    } finally { manualCheck = false; }
  });

  ipcMain.handle(IpcChannels.UPDATE_DOWNLOAD, async () => {
    if (!enabled()) return { ok: false, error: 'updates disabled' };
    if (busy) return { ok: false, error: 'update already in progress' };
    if (!latest) return { ok: false, error: 'no update available — check first' };
    busy = true;
    try {
      await autoUpdater.downloadUpdate();   // resolves when downloaded; events drive the UI
      return { ok: true, version: latest.version };
    } catch (e) {
      busy = false;
      return { ok: false, error: msg(e) };
    }
  });

  ipcMain.handle(IpcChannels.UPDATE_INSTALL, async () => {
    if (!downloaded) return { ok: false, error: 'nothing downloaded' };
    emit({ type: 'installing' });
    markJustUpdated(latest?.version || '');
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 300);  // silent, then relaunch
    return { ok: true };
  });

  ipcMain.handle(IpcChannels.UPDATE_SKIP, (_e, version: string) => {
    savePrefs({ ...loadPrefs(), skipVersion: version });
    return { ok: true };
  });

  ipcMain.handle(IpcChannels.UPDATE_OPEN_RELEASE, () => {
    shell.openExternal(latest?.url || RELEASES_URL);
    return { ok: true };
  });

  if (!enabled()) return;
  wire();
  const tick = () => { autoUpdater.checkForUpdates().catch(() => void 0); };
  setTimeout(tick, STARTUP_DELAY_MS);
  timer = setInterval(tick, CHECK_EVERY_MS);
}

export function stopUpdater(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// "updated to vX" toast after a quitAndInstall relaunch: NSIS relaunches without our argv,
// so remember the intent in a marker file and consume it once.
const markerPath = () => path.join(app.getPath('userData'), '.just-updated');
function markJustUpdated(version: string): void {
  try { fs.writeFileSync(markerPath(), version); } catch { /* ignore */ }
}
function wasJustUpdated(): boolean {
  try {
    const v = fs.readFileSync(markerPath(), 'utf8').trim();
    fs.unlinkSync(markerPath());
    return !!v && v === app.getVersion();
  } catch { return false; }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
