import path from 'node:path';

// A terminal may inherit Windows/System32 from its launcher. It is not a project
// folder: never turn that inherited cwd into an additional writable sandbox root.
export function workingFolder(folder, officeRoot, windowsRoot = process.env.SystemRoot || process.env.WINDIR) {
  if (!folder) return undefined;
  const dir = path.resolve(String(folder));
  const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  if (norm(dir) === norm(officeRoot)) return undefined;
  if (windowsRoot) {
    const relative = path.relative(path.resolve(windowsRoot), dir);
    if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) return undefined;
  }
  return dir;
}
