import { chmod, readFile, writeFile } from 'node:fs/promises';

const file = new URL('../dist/cli.js', import.meta.url);
let content = await readFile(file, 'utf8');
if (!content.startsWith('#!')) {
  content = '#!/usr/bin/env node\n' + content;
  await writeFile(file, content, 'utf8');
}
await chmod(file, 0o755);
