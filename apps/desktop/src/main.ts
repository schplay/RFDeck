import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import { spawn, exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      // .cjs — Electron loads preload as CommonJS, and this package is ESM.
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../../web/dist/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startServer() {
  const serverDir = path.join(__dirname, '../../server');
  const serverPath = path.join(serverDir, 'dist/server.js');

  serverProcess = spawn('node', ['--tls-min-v1.0', serverPath], {
    stdio: 'inherit',
    cwd: serverDir,
    env: {
      ...process.env,
      PORT: '3000',
      NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --openssl-legacy-provider',
    },
  });

  serverProcess.on('error', (err) => {
    console.error('[Electron] Failed to start server sidecar:', err);
  });
}

async function ensureWindowsFirewall(): Promise<void> {
  if (process.platform !== 'win32') return;

  // Port-specific rules (well-known ports that must be open regardless of process)
  const portRules = [
    { name: 'RFDeck mDNS Discovery',   port: '5353'  },
    { name: 'RFDeck Sennheiser G3/G4', port: '53212' },
  ];

  for (const rule of portRules) {
    let exists = false;
    try {
      const { stdout } = await execAsync(
        `netsh advfirewall firewall show rule name="${rule.name}"`,
        { timeout: 5000 }
      );
      exists = !stdout.includes('No rules match');
    } catch { /* attempt to add regardless */ }

    if (exists) continue;

    const args = [
      'advfirewall', 'firewall', 'add', 'rule',
      `name="${rule.name}"`,
      'protocol=UDP',
      'dir=in',
      `localport=${rule.port}`,
      'action=allow',
      'enable=yes',
    ];

    try {
      await execAsync(`netsh ${args.join(' ')}`, { timeout: 8000 });
      console.log(`[Firewall] Added rule: ${rule.name} (UDP ${rule.port})`);
    } catch {
      try {
        const psArgs = args.map((a) => `'${a}'`).join(', ');
        await execAsync(
          `powershell -NonInteractive -WindowStyle Hidden -Command "Start-Process netsh -ArgumentList ${psArgs} -Verb RunAs -Wait"`,
          { timeout: 30000 }
        );
        console.log(`[Firewall] Added rule (elevated): ${rule.name} (UDP ${rule.port})`);
      } catch {
        console.warn(`[Firewall] Could not add rule ${rule.name} — some devices may not connect`);
      }
    }
  }

  // Application-level rule for the Node.js server process.
  // Sennheiser EW-DX SSCv1 telemetry responses arrive on the ephemeral source port
  // used to send the subscription — there is no fixed inbound port to allow. Bitfocus
  // Companion solves this by having Windows grant a blanket "allow all" exception to
  // the Companion executable on first launch. We replicate that by adding an explicit
  // application-level allow rule for node.exe so inbound UDP on any port is permitted
  // for the server subprocess, matching what Companion gets automatically.
  const appRuleName = 'RFDeck Node Server';
  let appRuleExists = false;
  try {
    const { stdout } = await execAsync(
      `netsh advfirewall firewall show rule name="${appRuleName}"`,
      { timeout: 5000 }
    );
    appRuleExists = !stdout.includes('No rules match');
  } catch { /* attempt to add regardless */ }

  if (!appRuleExists) {
    try {
      const { stdout: nodePathRaw } = await execAsync('where node', { timeout: 5000 });
      const nodePath = nodePathRaw.split(/\r?\n/)[0].trim();
      if (nodePath) {
        const args = [
          'advfirewall', 'firewall', 'add', 'rule',
          `name="${appRuleName}"`,
          `program="${nodePath}"`,
          'protocol=UDP',
          'dir=in',
          'action=allow',
          'enable=yes',
        ];
        try {
          await execAsync(`netsh ${args.join(' ')}`, { timeout: 8000 });
          console.log(`[Firewall] Added application rule for ${nodePath}`);
        } catch {
          try {
            const psArgs = args.map((a) => `'${a}'`).join(', ');
            await execAsync(
              `powershell -NonInteractive -WindowStyle Hidden -Command "Start-Process netsh -ArgumentList ${psArgs} -Verb RunAs -Wait"`,
              { timeout: 30000 }
            );
            console.log(`[Firewall] Added application rule (elevated) for ${nodePath}`);
          } catch {
            console.warn('[Firewall] Could not add application rule for node.exe — EW-DX telemetry may not arrive');
          }
        }
      }
    } catch {
      console.warn('[Firewall] Could not locate node.exe — EW-DX telemetry may not arrive');
    }
  }
}

app.on('ready', async () => {
  await ensureWindowsFirewall();
  startServer();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
