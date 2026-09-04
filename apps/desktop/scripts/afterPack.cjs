// Strip development artefacts that electron-builder copies in with the
// @rfdeck/server workspace dependency.
//
// `files` exclusion patterns do not apply to bundled dependencies, so this runs
// after packaging instead. Two of these are correctness problems, not just size:
//
//   .env — contains DATABASE_URL=file:./rfdeck.db. Prisma loads it and it wins
//   over the environment the app passes, so the packaged app would open a
//   database inside its own install directory instead of the one in the user
//   data directory. Under Program Files that location is read-only.
//
//   prisma/*.db — the developer's own database, complete with their inventory
//   and show history. Shipping it to every install is a privacy problem as much
//   as a correctness one.
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources');
  const serverPkg = path.join(resources, 'app', 'node_modules', '@rfdeck', 'server');

  const removed = [];

  const remove = (target, label) => {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(label);
  };

  remove(path.join(serverPkg, '.env'), '@rfdeck/server/.env');
  remove(path.join(serverPkg, 'src'), '@rfdeck/server/src');
  remove(path.join(serverPkg, 'tsconfig.json'), '@rfdeck/server/tsconfig.json');

  // Any SQLite file that rode along, from either copy of the server tree.
  for (const dir of [
    path.join(serverPkg, 'prisma'),
    path.join(resources, 'app', 'server', 'prisma'),
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (/\.db(-journal|-wal|-shm)?$/.test(entry)) {
        remove(path.join(dir, entry), `${path.basename(dir)}/${entry}`);
      }
    }
  }

  if (removed.length) {
    console.log(`  • stripped dev artefacts  files=${removed.join(', ')}`);
  }

  ensureFfmpeg(context, resources);
};

// The capture backend for this platform.
//
// On Windows and macOS the server captures audio through ffmpeg — there is no
// arecord — so a build without it has no audio at all. ffmpeg-static is a
// production dependency and normally arrives with the rest of them; this only
// steps in if that walk misses it, so the failure is a missing binary at build
// time rather than a silent one in a venue.
function ensureFfmpeg(context, resources) {
  const win = context.electronPlatformName === 'win32';
  const exe = win ? 'ffmpeg.exe' : 'ffmpeg';

  const bundled = path.join(resources, 'app', 'node_modules', 'ffmpeg-static', exe);
  if (fs.existsSync(bundled)) {
    if (!win) fs.chmodSync(bundled, 0o755);
    return;
  }

  const source = path.join(__dirname, '..', 'node_modules', 'ffmpeg-static', exe);
  if (!fs.existsSync(source)) {
    throw new Error(
      `No ffmpeg at ${source}. The packaged app would ship without audio capture. ` +
      `Run "pnpm install" — ffmpeg-static downloads its binary in a postinstall step, ` +
      `which pnpm skips unless the package is listed under onlyBuiltDependencies.`
    );
  }

  const dest = path.join(resources, 'ffmpeg', exe);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
  if (!win) fs.chmodSync(dest, 0o755);
  console.log(`  • staged ffmpeg  to=resources/ffmpeg/${exe}`);
}
