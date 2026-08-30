import { app, BrowserWindow, shell, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow = null;
let serverProcess = null;
const SERVER_PORT = 3000;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

function startBackendServer() {
  process.env.PORT = SERVER_PORT.toString();
  process.env.APP_DATA_DIR = app.getPath('userData');
  import('./server.js').catch(err => {
    console.error('Failed to start embedded backend server:', err);
  });
}

function waitForServer(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const check = () => {
      http.get(url, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve(true);
        } else {
          retry();
        }
      }).on('error', () => {
        retry();
      });
    };

    const retry = () => {
      if (Date.now() - startTime > timeoutMs) {
        return reject(new Error('Server start timed out'));
      }
      setTimeout(check, 300);
    };

    check();
  });
}

async function createMainWindow() {
  const iconPath = path.join(__dirname, 'assets', 'logo', 'windows', 'app.ico');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: 'NANDU IMAGE FLUX',
    icon: iconPath,
    backgroundColor: '#0a0d14',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  try {
    await waitForServer(SERVER_URL);
    await mainWindow.loadURL(SERVER_URL);
  } catch (err) {
    console.error('Loading embedded UI directly:', err);
    await mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  startBackendServer();
  await createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});
