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
};
