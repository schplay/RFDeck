# Scripts

| Script | Use |
|---|---|
| **`install-ubuntu.sh`** | **Provision a server.** Clean Ubuntu box → running service on the network. |
| **`update-server.sh`** | **Deploy code updates** to a server that is already provisioned. |
| `deploy-server.ps1` | Run a server on a Windows dev machine for local testing. |
| `deploy-server.sh` | Same, for a Linux or macOS dev machine. |
| `open-firewall.ps1` | Open the inbound ports on Windows (as Administrator). |

The first is the deployment path. The rest are development conveniences and do
not install anything.

> **Adding a shell script from Windows?** Set the executable bit in git
> explicitly — `core.filemode` is `false` there, so `chmod +x` alone does not
> reach the index and the file lands non-executable on the server:
>
> ```bash
> git update-index --chmod=+x scripts/your-script.sh
> ```
>
> The deploy scripts also `chmod +x` the scripts directory after staging, so a
> missed bit cannot leave the *next* upgrade unrunnable.

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

It serves on port 80, so the address is just the server's IP with nothing to
remember. Binding a privileged port does not require running as root — the
systemd unit grants `CAP_NET_BIND_SERVICE` and nothing else.

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
| `--port` | `80` | Web interface and API port |
| `--repo` / `--branch` | — | Clone instead of copying the local checkout |
| `--install-dir` | `/opt/rfdeck` | Application location |
| `--data-dir` | `/var/lib/rfdeck` | Database location |
| `--skip-firewall` | off | Leave `ufw` alone |
| `--uninstall` | — | Remove the service and application, keep the database |

### Updating

Two different jobs, two scripts:

| | `update-server.sh` | `install-ubuntu.sh` |
|---|---|---|
| Purpose | Ship new code | Provision or reconfigure |
| Typical time | Under a minute | Several minutes |
| Runs apt / installs Node | No | Yes |
| Rebuilds the AES67 kernel module | No | Yes |
| Rewrites the systemd unit | No | Yes |
| Rolls back automatically on failure | Yes | No |

**For a code update**, which is nearly always what you want:

```bash
cd ~/rfdeck
sudo ./scripts/update-server.sh --pull
```

It stages the new code, rebuilds, applies additive schema changes, restarts, and
checks the service actually answers. If the build fails or the service does not
come back, it **restores the previous build and restarts it** — so an update
during a show week cannot leave you with nothing running.

Undo a good-but-unwanted update the same way:

```bash
sudo ./scripts/update-server.sh --rollback
```

It reads the port, scheme, database path and service account out of the live
systemd unit rather than assuming defaults, so it cannot build against one
database and restart a service pointed at another.

**Re-run the installer instead** when configuration changes — switching to TLS,
changing the port, adding or removing AES67 — because those live in the systemd
unit, which `update-server.sh` deliberately leaves alone:

```bash
cd ~/rfdeck && git pull
sudo ./scripts/install-ubuntu.sh
```

Neither script touches the database, the TLS certificate, or the encryption key:
those live in `/var/lib/rfdeck`, outside the install directory, precisely so
that replacing the application can never take a venue's show history with it.

Running the installer *from* `/opt/rfdeck` rebuilds in place but cannot fetch
new code — the install directory has no `.git`.


---

## Administering the server

A headless server has no browser on the host, so shell access is a first-class
way to administer it — and the only way back in if the PIN is forgotten.

```bash
rfdeck status              # access and audio configuration
rfdeck set-pin 4821        # require a PIN from remote devices
rfdeck set-pin 4821 --reauth-hours 24
rfdeck disable-pin         # network becomes open again
rfdeck audio-devices       # capture devices and the current patch
```

Changing or disabling the PIN takes effect for new connections immediately;
restart the service to sign out devices already connected.

Everything except the PIN reset can also be done from a browser: whoever knows
the current PIN may change it. Only recovery from a *forgotten* PIN requires the
shell.

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
| 80 | TCP | Web interface, API, realtime socket |
| 53212 | UDP | Sennheiser MCP — G3/G4 discovery and telemetry |
| 5353 | UDP | mDNS / Bonjour — EW-DX discovery |

EW-DX SSCv1 telemetry arrives on an ephemeral port rather than a fixed one, so
it needs no rule of its own on Linux — connection tracking handles the replies.

The service runs as an unprivileged account. Port 80 is the only privileged
bind, granted via `CAP_NET_BIND_SERVICE` in the systemd unit; the UDP ports are
all above 1024.

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
