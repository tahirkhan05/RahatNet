/**
 * Bundles @rahatnet/types into the functions dist so it doesn't need
 * the workspace: protocol at runtime (Cloud Build uses plain npm).
 */
const fs = require('fs');
const path = require('path');

const typesDistCjs = path.join(__dirname, '../../../packages/types/dist-cjs');
const typesDest = path.join(__dirname, '../dist/@rahatnet/types');

if (!fs.existsSync(typesDistCjs)) {
  console.error('types dist-cjs not found — run: npm --prefix packages/types run build first');
  process.exit(1);
}

// Copy CJS types into dist
fs.mkdirSync(typesDest, { recursive: true });
for (const file of fs.readdirSync(typesDistCjs)) {
  fs.copyFileSync(path.join(typesDistCjs, file), path.join(typesDest, file));
}

// Patch all dist/*.js files to resolve @rahatnet/types → bundled copy
const distDir = path.join(__dirname, '../dist');
function patchDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '@rahatnet') {
      patchDir(full);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      let content = fs.readFileSync(full, 'utf8');
      // Replace require('@rahatnet/types') with relative path to bundled copy
      const rel = path.relative(path.dirname(full), typesDest).replace(/\\/g, '/');
      content = content.replace(/require\(['"]@rahatnet\/types['"]\)/g, `require('${rel}')`);
      fs.writeFileSync(full, content);
    }
  }
}
patchDir(distDir);
console.log('✓ @rahatnet/types bundled into dist');
