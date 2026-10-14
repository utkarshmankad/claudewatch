import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import semver from 'semver';

const root = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const incompatible = [];

for (const dependency of Object.keys(root.dependencies ?? {})) {
  const manifestPath = path.join('node_modules', ...dependency.split('/'), 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const required = manifest.engines?.node;
  if (required && !semver.satisfies(process.version, required, { includePrerelease: true })) {
    incompatible.push(`${dependency}@${manifest.version} requires Node ${required}`);
  }
}

if (incompatible.length > 0) {
  console.error(`Production dependencies incompatible with ${process.version}:`);
  for (const message of incompatible) console.error(`- ${message}`);
  process.exitCode = 1;
} else {
  console.log(`All direct production dependencies support ${process.version}.`);
}
