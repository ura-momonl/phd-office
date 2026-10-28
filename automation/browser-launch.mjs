// Edge/Chromium startup can probe the Windows user's empty password and cause
// account lockout. Merge the workaround with the installed Playwright defaults;
// avoid duplicate --disable-features switches that can override existing flags.
import { createRequire } from 'node:module';

export const LOCKOUT_FEATURE = 'AutofillAiWalletPrivatePasses';
const prefix = '--disable-features=';

export function safeLaunchOptions(defaultArgs, options = {}) {
  const ignored = options.ignoreDefaultArgs;
  const defaults = defaultArgs.filter(arg => arg.startsWith(prefix) && ignored !== true && !ignored?.includes(arg));
  const args = options.args || [];
  const features = [...new Set([...defaults, ...args.filter(arg => arg.startsWith(prefix))]
    .flatMap(arg => arg.slice(prefix.length).split(',')).filter(Boolean).concat(LOCKOUT_FEATURE))];
  return {
    ...options,
    ignoreDefaultArgs: ignored === true ? true : [...new Set([...(ignored || []), ...defaults])],
    args: [...args.filter(arg => !arg.startsWith(prefix)), prefix + features.join(',')]
  };
}

export async function launchEdge(options = {}) {
  const url = process.env.PHD_TEST_PLAYWRIGHT || import.meta.resolve('playwright-core');
  const { chromium } = await import(url);
  // Playwright has no public API for its default switches. Use its exported
  // server module to compute them without starting a browser or copying a list.
  // If this API changes on upgrade, fail before launch rather than lose flags.
  const server = createRequire(url)('playwright-core/lib/server');
  const defaults = await server.createPlaywright({ sdkLanguage: 'javascript' }).chromium
    .defaultArgs({ headless: true }, false, 'unused');
  if (!defaults.some(arg => arg.startsWith(prefix))) throw new Error('Cannot read Playwright disabled features; browser not started');
  return chromium.launch(safeLaunchOptions(defaults, {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    ...options
  }));
}
