#!/usr/bin/env node
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Catalog } from './catalog.mjs';
import { loadConfig } from './config.mjs';
import { buildSnapshot, validateSnapshot } from './compiler.mjs';
import { runDaemon } from './daemon.mjs';
import { registerInput, sha256File } from './ingest.mjs';
import { runMaintenance } from './maintenance.mjs';
import { publishSnapshot } from './publisher.mjs';

function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (['once', 'json', 'detach'].includes(key)) options[key] = true;
    else {
      if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new Error(`Missing value for --${key}`);
      options[key] = argv[++index];
    }
  }
  return { positional, options };
}

function output(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function main() {
  const { positional, options } = parseArguments(process.argv.slice(2));
  const [command, subcommand, argument] = positional;
  if (!command) throw new Error('Usage: book-forge <init|source add|daemon|pause|resume|status|snapshot build|validate|publish>');
  const config = await loadConfig({ configFile: options.config, workspace: options.workspace });
  if (command === 'validate') {
    output({ ok: true, ...(await validateSnapshot(path.resolve(subcommand))) });
    return;
  }
  const catalog = new Catalog(config);
  try {
    if (command === 'init') {
      output({ ok: true, schema: 'flashfork_book_forge_init_v1', workspace: config.workspace, status: catalog.status() });
    } else if (command === 'source' && subcommand === 'add') {
      if (!argument && !options.fixture) throw new Error('source add requires a PGN path or --fixture <id>');
      const source = await registerInput(catalog, { filename: argument, fixtureId: options.fixture });
      output({ ok: true, source: { ...source, id: Number(source.id), fixture: Boolean(source.fixture) } });
    } else if (command === 'source' && ['quarantine', 'retire', 'restore'].includes(subcommand)) {
      if (!argument || !/^\d+$/.test(argument)) throw new Error(`source ${subcommand} requires a numeric source id`);
      const lifecycle = subcommand === 'restore' ? 'restored' : `${subcommand}d`;
      output({ ok: true, source: catalog.setSourceLifecycle(Number(argument), lifecycle) });
    } else if (command === 'daemon') {
      if (options.detach) {
        const childArguments = [fileURLToPath(import.meta.url), 'daemon', '--workspace', config.workspace];
        if (options.config) childArguments.push('--config', path.resolve(options.config));
        if (options.once) childArguments.push('--once');
        const child = spawn(process.execPath, childArguments, { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        output({ ok: true, detached: true, pid: child.pid, workspace: config.workspace });
      } else {
        output({ ok: true, report: await runDaemon(catalog, config, { once: Boolean(options.once) }) });
      }
    } else if (command === 'pause') {
      catalog.setPaused(true, options.reason ?? 'operator pause');
      output({ ok: true, control: catalog.control() });
    } else if (command === 'resume') {
      catalog.setPaused(false);
      output({ ok: true, control: catalog.control() });
    } else if (command === 'status') {
      output({ ok: true, status: catalog.status() });
    } else if (command === 'snapshot' && subcommand === 'build') {
      output({ ok: true, snapshot: await buildSnapshot(catalog, config, options.channel ?? 'integration') });
    } else if (command === 'qualification' && subcommand === 'record') {
      if (!options.content || !/^[0-9a-f]{20}$/.test(options.content)) throw new Error('qualification record requires --content <20-hex-id>');
      if (!options.evidence) throw new Error('qualification record requires --evidence <artifact-path>');
      const evidenceSha256 = await sha256File(path.resolve(options.evidence));
      const eloLowerBound = Number(options['elo-lower-bound']);
      const regressions = Number(options['uci-regressions']);
      if (!Number.isFinite(eloLowerBound) || !Number.isInteger(regressions) || regressions < 0) {
        throw new Error('qualification record requires numeric --elo-lower-bound and nonnegative integer --uci-regressions');
      }
      catalog.recordQualificationGate(options.content, 'paired_color_non_inferiority', eloLowerBound >= -5,
        { elo_lower_bound: eloLowerBound, evidence_sha256: evidenceSha256 });
      catalog.recordQualificationGate(options.content, 'uci_compatibility', regressions === 0,
        { regressions, evidence_sha256: evidenceSha256 });
      output({ ok: true, contentId: options.content, gates: catalog.qualificationGates(options.content) });
    } else if (command === 'maintain') {
      output({ ok: true, maintenance: await runMaintenance(catalog, config, { force: true }) });
    } else if (command === 'publish') {
      if (!subcommand) throw new Error('publish requires a snapshot directory');
      output({ ok: true, publication: await publishSnapshot(catalog, config, path.resolve(subcommand), options.channel ?? 'integration') });
    } else {
      throw new Error(`Unknown command: ${positional.join(' ')}`);
    }
  } finally {
    catalog.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
});
