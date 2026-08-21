import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, exec, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;

// ── Layout ──
//
// In development the shell runs from apps/desktop/dist and its siblings are
// reachable with relative paths. Once packaged, the frontend and server are
// copied into the app's resources directory instead (see electron-builder.yml
// extraResources), so every path has to be resolved through resourcesPath.
// Getting this wrong is silent: the window simply loads nothing.
const paths = app.isPackaged
  ? {
      webIndex:  path.join(process.resourcesPath, 'web', 'index.html'),
      // Inside app/ so the sidecar can resolve its dependencies from
      // app/node_modules — see electron-builder.yml.
      serverDir: path.join(process.resourcesPath, 'app', 'server'),
      serverJs:  path.join(process.resourcesPath, 'app', 'server', 'dist', 'server.js'),
      schema:    path.join(process.resourcesPath, 'app', 'server', 'prisma', 'schema.prisma'),
    }
  : {
      webIndex:  path.join(__dirname, '../../web/dist/index.html'),
      serverDir: path.join(__dirname, '../../server'),
      serverJs:  path.join(__dirname, '../../server/dist/server.js'),
      schema:    path.join(__dirname, '../../server/prisma/schema.prisma'),
    };

// The install directory is read-only under Program Files, so the database has
// to live in the per-user data directory. This is also what makes the data
// survive an app upgrade, which replaces the install directory wholesale.
//
// On first run there is no database yet and a packaged app cannot run
// `prisma db push`, so an empty pre-migrated template is copied across.
function databaseUrl(): string {
  const dir = app.getPath('userData');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const dbFile = path.join(dir, 'rfdeck.db');

  if (!fs.existsSync(dbFile)) {
    const template = app.isPackaged
      ? path.join(process.resourcesPath, 'template.db')
      : path.join(__dirname, '..', 'resources', 'template.db');

    if (fs.existsSync(template)) {
      fs.copyFileSync(template, dbFile);
      console.log(`[Electron] Initialised database at ${dbFile}`);
    } else {
      // The server will still start and Prisma will create the file, but the
      // tables will be missing — worth saying so rather than failing obscurely.
      console.error(`[Electron] No database template at ${template}; schema may be missing`);
    }
  }

  // Prisma wants a URL; backslashes in a Windows path are not valid in one.
  return `file:${dbFile.replace(/\\/g, '/')}`;
}

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

  if (!fs.existsSync(paths.webIndex)) {
    // Fail loudly rather than showing an empty window, which looks like a hang.
    console.error(`[Electron] Frontend not found at ${paths.webIndex}`);
    mainWindow.loadURL(
      'data:text/html,' + encodeURIComponent(
        `<body style="font-family:system-ui;background:#131314;color:#e9e9ec;padding:40px">
         <h2>RFDeck could not start</h2>
         <p>The interface files are missing from this installation.</p>
         <p style="color:#8d8d99;font-family:monospace;font-size:12px">${paths.webIndex}</p>
         </body>`
      )
    );
    return;
  }

  mainWindow.loadFile(paths.webIndex);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function startServer() {
  if (!fs.existsSync(paths.serverJs)) {
    console.error(`[Electron] Server not found at ${paths.serverJs}`);
    return;
  }

  // Run the sidecar with Electron's own bundled Node rather than spawning
  // `node`, which a target machine is not required to have installed.
  // ELECTRON_RUN_AS_NODE turns this same executable into a plain Node runtime.
  serverProcess = spawn(process.execPath, ['--tls-min-v1.0', paths.serverJs], {
    stdio: 'inherit',
    cwd: paths.serverDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: '3000',
      DATABASE_URL: databaseUrl(),
      PRISMA_SCHEMA_PATH: paths.schema,
      NODE_OPTIONS: (process.env.NODE_OPTIONS ?? '') + ' --openssl-legacy-provider',
    },
  });

  serverProcess.on('error', (err) => {
    console.error('[Electron] Failed to start server sidecar:', err);
  });

  serverProcess.on('exit', (code, signal) => {
    if (code !== 0 && code !== null) {
      console.error(`[Electron] Server sidecar exited with code ${code} (${signal ?? 'no signal'})`);
    }
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
      // Target whichever executable actually hosts the server. Packaged, that
      // is our own Electron binary running with ELECTRON_RUN_AS_NODE; in
      // development it is the system node. A rule pointing at node.exe on a
      // machine without Node installed would silently protect nothing.
      let nodePath: string;
      if (app.isPackaged) {
        nodePath = process.execPath;
      } else {
        const { stdout: nodePathRaw } = await execAsync('where node', { timeout: 5000 });
        nodePath = nodePathRaw.split(/\r?\n/)[0].trim();
      }
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
