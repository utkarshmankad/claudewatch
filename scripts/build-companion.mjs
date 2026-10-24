// Assembles the static companion site into dist/companion-site: the hand-written shell in companion/ plus the compiled
// renderer from dist/companion/. Run after `npm run build`. No bundler; the output has no third-party code.
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';

const out = 'dist/companion-site';
if (!existsSync('dist/companion/render.js')) {
  console.error('dist/companion/render.js is missing; run `npm run build` first.');
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync('companion', out, { recursive: true });
cpSync('dist/companion/render.js', `${out}/render.js`);
console.log(`companion site written to ${out}`);
