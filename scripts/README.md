# Scripts

Tooling for building and deploying RFDeck.

| Script | Purpose |
|---|---|
| `deploy-server.ps1` | Provision and run a headless server (Windows) |
| `deploy-server.sh` | Same, for Linux and macOS |
| `open-firewall.ps1` | Open the inbound ports RFDeck needs (Windows, as Administrator) |

Full deployment reference, including backup and troubleshooting, is in
[`../docs/DEPLOYMENT.md`](../docs/DEPLOYMENT.md).

---

## Deploying a server for testing

From a clean checkout:

```powershell
# Windows
.\scripts\open-firewall.ps1      # as Administrator, once per machine
.\scripts\deploy-server.ps1
```

```bash
# Linux / macOS
./scripts/deploy-server.sh
```

That installs dependencies, generates the Prisma client, builds all three
packages, creates the database, and starts the server. It prints every address
clients can reach it on.

Re-running is safe. An existing database is kept and the schema is updated in
place, so this doubles as the upgrade path after a schema change.

### Options

| Flag | Default | Notes |
|---|---|---|
| `-Port` / `--port` | `3000` | HTTP port |
| `-DataDir` / `--data` | `apps/server` | Where `rfdeck.db` lives |
| `-NoStart` / `--no-start` | off | Build and migrate only — for a service install |
| `-Check` / `--check` | off | Verify prerequisites and exit |

Keeping the database outside the repo is worth doing for anything you care
about, so a `git clean` cannot take your show history with it:

```powershell
.\scripts\deploy-server.ps1 -DataDir D:\rfdeck-data
```

---

## Ports

Only the HTTP port is obvious. **The three UDP ports are where deployments go
wrong**: with them blocked, devices are discovered but never report telemetry,
which looks exactly like broken hardware rather than a firewall problem.

| Port | Protocol | Purpose |
|---|---|---|
| 3000 | TCP | API, frontend, realtime socket |
| 53212 | UDP | Sennheiser MCP — G3/G4 discovery and telemetry |
| 5353 | UDP | mDNS / Bonjour — EW-DX discovery |
| 45 | UDP | SSCv1 — EW-DX live telemetry |

The desktop build opens these itself on first run. A headless server does not —
that is what `open-firewall.ps1` is for.

---

## Running as a service

Build without starting, then point a service manager at the server:

```powershell
.\scripts\deploy-server.ps1 -NoStart -DataDir D:\rfdeck-data
```

The script prints the exact command to run, including the `DATABASE_URL` it
provisioned. Pass that same value to the service — the server honours it, and
without it will fall back to a database beside its own build output.

`docs/DEPLOYMENT.md` has a systemd unit and notes on NSSM for Windows.

---

## Desktop packaging

```bash
pnpm --filter @rfdeck/desktop package
```

Produces `apps/desktop/release/RFDeck Setup 1.0.0.exe`. The command builds the
whole workspace first, so the installer can never ship a stale frontend or
server against a fresh shell.

Three steps run before electron-builder, each fixing something the packaged app
cannot do for itself:

- **`build-preload.mjs`** compiles the preload to CommonJS as `.cjs`. Electron
  loads preload scripts as CJS, but the package is ESM, so a `.js` file would
  throw at every startup.
- **`build-db-template.mjs`** produces an empty database with the schema
  applied. A packaged install cannot run `prisma db push`, and the install
  directory is read-only under Program Files, so the app copies this template
  into the user data directory on first run.
- **`stage-prisma-client.mjs`** copies the generated Prisma client and its
  native query engine. That client is build output rather than a declared
  dependency, so electron-builder's dependency walk never sees it — and without
  it every database call fails at runtime.

`afterPack.cjs` then strips development artefacts that arrive with the
`@rfdeck/server` workspace dependency: its `.env`, which would override
`DATABASE_URL` to a read-only location, and the developer's own database, which
would otherwise ship to every install.

**Close RFDeck before packaging.** A running instance holds the Prisma query
engine DLL and `prisma generate` fails with `EPERM`.
