#!/usr/bin/env node
// Regenerates _locales/en_XA (pseudo-locale) from the English source catalog.
// Run: node scripts/build-locales.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pseudoLocalizeCatalog } from '../lib/pseudo-locale.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const en = JSON.parse(readFileSync(join(root, '_locales/en/messages.json'), 'utf8'));
mkdirSync(join(root, '_locales/en_XA'), { recursive: true });
writeFileSync(join(root, '_locales/en_XA/messages.json'), `${JSON.stringify(pseudoLocalizeCatalog(en), null, 2)}\n`);
console.log(`Wrote en_XA with ${Object.keys(en).length} messages`);
