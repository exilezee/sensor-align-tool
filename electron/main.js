import { app, BrowserWindow } from 'electron';
import net from 'net';

const PORT = 4000;

function waitForServer() {
  return new Promise((resolve) => {
    const check = () => {
      const socket = net.createConnection(PORT, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => { socket.destroy(); setTimeout(check, 300); });
    };
    check();
  });
}

app.whenReady().then(async () => {
  await import('../server.js');
  await waitForServer();

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    autoHideMenuBar: true,
    title: 'Sensor Alignment Tool',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadURL(`http://localhost:${PORT}`);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
