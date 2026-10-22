// Local packaging only: no registry, credential lookup, lifecycle scripts or publish.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const pkg = fileURLToPath(new URL('../', import.meta.url));
const repository = pkg;
const artifacts = path.join(pkg, 'artifacts');
const consumer = mkdtempSync(path.join(tmpdir(), 'trustedstake-sdk-consumer-'));
const run = (command, args, cwd = pkg) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
};
try {
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(path.join(consumer, 'npm-user.conf'), '');
  writeFileSync(path.join(consumer, 'npm-global.conf'), '');
  const [packed] = JSON.parse(run('npm', [
    'pack', '--offline', '--ignore-scripts', '--json', '--pack-destination', artifacts,
    '--cache', path.join(consumer, 'npm-cache'),
    '--userconfig', path.join(consumer, 'npm-user.conf'),
    '--globalconfig', path.join(consumer, 'npm-global.conf'),
  ]));
  const names = packed.files.map(file => file.path);
  assert(names.includes('AGENT-INTEGRATION.md'));
  assert(names.includes('examples/agent-quickstart.ts'));
  assert(names.includes('examples/native-ui/assets/TS_logo_wordmark_white.svg'));
  assert(names.every(name => !name.split('/').some(part =>
    part.startsWith('.env') || ['node_modules', 'src', 'test', '.agent'].includes(part))));
  for (const entry of ['browser', 'core', 'server']) {
    assert(names.includes(`dist/${entry}.js`));
    assert(names.includes(`dist/${entry}.d.ts`));
  }
  const installed = path.join(consumer, 'node_modules/@trustedstake/partner-sdk');
  const tarball = path.join(artifacts, packed.filename);
  writeFileSync(path.join(consumer, 'package.json'), '{"name":"sdk-clean-consumer","version":"1.0.0","private":true,"type":"module"}\n');
  run('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    '--cache', path.join(consumer, 'npm-cache'), '--userconfig', path.join(consumer, 'npm-user.conf'),
    '--globalconfig', path.join(consumer, 'npm-global.conf'), tarball], consumer);
  run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createPartnerClient } from '@trustedstake/partner-sdk';
    import { SDK_VERSION, PARTNER_API_VERSION } from '@trustedstake/partner-sdk/core';
    import { createServerBridge } from '@trustedstake/partner-sdk/server';
    assert.equal(typeof createPartnerClient, 'function');
    assert.equal(typeof createServerBridge, 'function');
    assert.equal(PARTNER_API_VERSION, 1);
    assert.equal(SDK_VERSION, ${JSON.stringify(packed.version)});
  `], consumer);
  run(process.execPath, [path.join(repository, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--lib', 'ES2022,DOM,DOM.Iterable',
    path.join(installed, 'examples/agent-quickstart.ts'),
    path.join(installed, 'examples/server-bridge.ts'),
  ], consumer);
  // The framework-neutral entries above work without Polkadot. Qualify the optional entry
  // separately against the host's already installed peers, with no registry or install.
  mkdirSync(path.join(consumer, 'node_modules/@polkadot'), { recursive: true });
  for (const name of ['api', 'types', 'util', 'util-crypto']) {
    symlinkSync(path.join(repository, 'node_modules/@polkadot', name), path.join(consumer, 'node_modules/@polkadot', name));
  }
  run(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { prepareMultisigAction, createAuthorizationDeposit, importMultisigProposal } from '@trustedstake/partner-sdk/polkadot';
    for (const fn of [prepareMultisigAction, createAuthorizationDeposit, importMultisigProposal]) assert.equal(typeof fn, 'function');
  `], consumer);
  run(process.execPath, [path.join(repository, 'node_modules/typescript/bin/tsc'),
    '--noEmit', '--strict', '--skipLibCheck', '--target', 'ES2022',
    '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--lib', 'ES2022,DOM,DOM.Iterable',
    path.join(installed, 'examples/multisig-quickstart.ts'),
  ], consumer);
  const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  writeFileSync(`${tarball}.sha256`, `${digest}  ${packed.filename}\n`);
  console.log(JSON.stringify({ filename: packed.filename, sha256: digest,
    files: names.length, entryPoints: 'passed (core/browser/server without peers; optional polkadot with installed peers)', typedExamples: 'passed (3)', published: false }, null, 2));
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
