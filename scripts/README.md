# Scripts

| Script | Use |
|---|---|
| **`install-ubuntu.sh`** | **Deploy a server.** Clean Ubuntu box → running service on the network. |
| `deploy-server.ps1` | Run a server on a Windows dev machine for local testing. |
| `deploy-server.sh` | Same, for a Linux or macOS dev machine. |
| `open-firewall.ps1` | Open the inbound ports on Windows (as Administrator). |

The first is the deployment path. The rest are development conveniences and do
not install anything.

---

## Deploying a server

On a fresh Ubuntu 22.04 or 24.04 machine:

```bash
git clone <your-repo> rfdeck && cd rfdeck
sudo ./scripts/install-ubuntu.sh
```

Or straight from a repository URL, without cloning first:

```bash
sudo ./scripts/install-ubuntu.sh --repo https://github.com/you/rfdeck.git
```

It prints the addresses to open in a browser when it finishes.

### What it does

1. Installs Node 24 from NodeSource, plus the build tools the native WebRTC
   module needs
2. Creates an unprivileged `rfdeck` service account with no login shell
3. Stages the application into `/opt/rfdeck`
4. Builds it — TypeScript has to be compiled once, at install time
5. Creates the database in `/var/lib/rfdeck`, outside the install directory
6. Registers a hardened systemd unit that starts on boot
7. Opens the firewall if `ufw` is active
8. Starts the service and **verifies it responds** before reporting success

### Options

| Flag | Default | Notes |
|---|---|---|
| `--port` | `3000` | Web interface and API port |
| `--repo` / `--branch` | — | Clone instead of copying the local checkout |
| `--install-dir` | `/opt/rfdeck` | Application location |
| `--data-dir` | `/var/lib/rfdeck` | Database location |
| `--skip-firewall` | off | Leave `ufw` alone |
| `--uninstall` | — | Remove the service and application, keep the database |

### Upgrading

Re-run it. The schema is updated in place and existing data is preserved:

```bash
cd /opt/rfdeck && sudo ./scripts/install-ubuntu.sh
```

The database deliberately lives in `/var/lib/rfdeck` rather than inside the
install directory, so replacing the application on upgrade can never take a
venue's show history with it.

---

## Operating the service

```bash
systemctl status rfdeck          # is it running
systemctl restart rfdeck         # restart
journalctl -u rfdeck -f          # follow the log
```

### Logging

The service is quiet by default — warnings and errors only. Per-device protocol
detail is `debug` and off, because at up to 128 channels it would fill the
journal and bury anything worth reading.

Turn it up while troubleshooting a device that will not connect:

```bash
sudo systemctl edit rfdeck
```

```ini
[Service]
Environment=LOG_LEVEL=debug
```

```bash
sudo systemctl restart rfdeck
journalctl -u rfdeck -f
```

Set it back to `warn` afterwards.

### Backup

Everything is in one file:

```bash
sudo systemctl stop rfdeck
sudo cp /var/lib/rfdeck/rfdeck.db /path/to/backup/
sudo systemctl start rfdeck
```

Copy `/var/lib/rfdeck/.rfdeck-key` too. Device passwords are encrypted with it,
and a backup without it restores everything *except* those — the devices simply
need their passwords re-entered.

---

## Ports

Only the HTTP port is obvious. **The UDP ports are where deployments fail**:
blocked, receivers are discovered but never report telemetry, which looks like
broken hardware rather than a firewall problem.

| Port | Protocol | Purpose |
|---|---|---|
| 3000 | TCP | Web interface, API, realtime socket |
| 53212 | UDP | Sennheiser MCP — G3/G4 discovery and telemetry |
| 5353 | UDP | mDNS / Bonjour — EW-DX discovery |

EW-DX SSCv1 telemetry arrives on an ephemeral port rather than a fixed one, so
it needs no rule of its own on Linux — connection tracking handles the replies.

The server binds only unprivileged ports, so it runs as a normal service account
with no elevated capabilities.

---

## Running a server on a dev machine

For testing on Windows without installing anything:

```powershell
.\scripts\open-firewall.ps1      # as Administrator, once
.\scripts\deploy-server.ps1
```

This builds the workspace and runs the server in the foreground. It is a
development convenience, not a deployment — nothing is installed and nothing
survives a reboot. Use `install-ubuntu.sh` for anything real.

---

## Desktop packaging

```bash
pnpm --filter @rfdeck/desktop package
```

Produces `apps/desktop/release/RFDeck Setup 1.0.0.exe`, building the whole
workspace first so the installer cannot ship a stale frontend against a fresh
shell.

Three steps run before electron-builder, each covering something the packaged
app cannot do for itself:

- **`build-preload.mjs`** compiles the preload to CommonJS as `.cjs` — Electron
  loads preload scripts as CJS, but the package is ESM, so a `.js` file throws
  at every startup.
- **`build-db-template.mjs`** produces an empty database with the schema
  applied. A packaged install cannot run `prisma db push`, and Program Files is
  read-only, so the app copies this into the user data directory on first run.
- **`stage-prisma-client.mjs`** copies the generated Prisma client and its
  native query engine, which is build output rather than a declared dependency
  and so is invisible to electron-builder's dependency walk.

`afterPack.cjs` then strips development artefacts that arrive with the
`@rfdeck/server` workspace dependency — its `.env`, which would override
`DATABASE_URL` to a read-only path, and the developer's own database, which
would otherwise ship to every install.

**Close RFDeck before packaging.** A running instance holds the Prisma query
engine DLL and `prisma generate` fails with `EPERM`.
