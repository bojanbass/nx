import { execSync } from 'child_process';
import { join } from 'path';
import { Document, parseDocument, Scalar, YAMLMap, YAMLSeq } from 'yaml';

import {
  NxJsonConfiguration,
  TargetDefaultEntry,
  TargetDefaults,
} from '../../../config/nx-json';
import {
  fileExists,
  readJsonFile,
  writeJsonFile,
} from '../../../utils/fileutils';
import { output } from '../../../utils/output';
import { PackageJson } from '../../../utils/package-json';
import {
  detectPackageManager,
  getPackageManagerCommand,
  getPackageManagerVersion,
  PackageManagerCommands,
} from '../../../utils/package-manager';
import { joinPathFragments } from '../../../utils/path';
import { nxVersion } from '../../../utils/versions';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { printSuccessMessage } from '../../../nx-cloud/generators/connect-to-nx-cloud/connect-to-nx-cloud';
import { connectWorkspaceToCloud } from '../../nx-cloud/connect/connect-to-nx-cloud';
import { deduceDefaultBase } from './deduce-default-base';
import { getRunNxBaseCommand } from '../../../utils/child-process';

export function createNxJsonFile(
  repoRoot: string,
  topologicalTargets: string[],
  cacheableOperations: string[],
  scriptOutputs: { [name: string]: string }
) {
  const nxJsonPath = joinPathFragments(repoRoot, 'nx.json');
  let nxJson = {} as Partial<NxJsonConfiguration> & { $schema: string };
  try {
    nxJson = readJsonFile(nxJsonPath);
  } catch {}

  nxJson.$schema = './node_modules/nx/schemas/nx-schema.json';
  const targetDefaults: TargetDefaults = { ...(nxJson.targetDefaults ?? {}) };

  if (topologicalTargets.length > 0) {
    for (const scriptName of topologicalTargets) {
      upsertTargetDefaultEntry(targetDefaults, scriptName, {
        dependsOn: [`^${scriptName}`],
      });
    }
  }
  for (const [scriptName, output] of Object.entries(scriptOutputs)) {
    if (!output) {
      continue;
    }
    upsertTargetDefaultEntry(targetDefaults, scriptName, {
      outputs: [`{projectRoot}/${output}`],
    });
  }

  for (const target of cacheableOperations) {
    const existing = readUnfilteredTargetDefault(targetDefaults, target);
    if (existing.cache === undefined) {
      upsertTargetDefaultEntry(targetDefaults, target, { cache: true });
    }
  }

  if (Object.keys(targetDefaults).length === 0) {
    delete nxJson.targetDefaults;
  } else {
    nxJson.targetDefaults = targetDefaults;
  }

  const defaultBase = deduceDefaultBase();
  // Do not add defaultBase if it is inferred to be the Nx default value of main
  if (defaultBase !== 'main') {
    nxJson.defaultBase ??= defaultBase;
  }
  writeJsonFile(nxJsonPath, nxJson);
}

/**
 * Locate-by-target upsert against an in-memory `targetDefaults` map. Merges
 * `patch`'s config into the unfiltered (catch-all) default for `target`,
 * promoting through the array form when one already exists. Used by `nx init`
 * code paths that operate on raw JSON before a Tree exists — generators
 * should use `upsertTargetDefault` from devkit instead.
 */
export function upsertTargetDefaultEntry(
  targetDefaults: TargetDefaults,
  target: string,
  patch: Partial<TargetDefaultEntry>
): void {
  // Drop locator fields — the key is `target` and `nx init` only writes
  // unfiltered defaults.
  const {
    target: _t,
    executor: _e,
    projects: _p,
    plugin: _pl,
    ...config
  } = patch;
  const existing = targetDefaults[target];
  if (Array.isArray(existing)) {
    const idx = existing.findIndex((e) => e.filter === undefined);
    if (idx >= 0) {
      const { filter, ...rest } = existing[idx];
      existing[idx] = { ...rest, ...config };
    } else {
      existing.push({ ...config });
    }
  } else {
    targetDefaults[target] = { ...(existing ?? {}), ...config };
  }
}

/**
 * Read the unfiltered (catch-all) config for `target` from a `targetDefaults`
 * map — the object value, or the filter-less entry of an array value.
 */
function readUnfilteredTargetDefault(
  targetDefaults: TargetDefaults,
  target: string
): Partial<TargetDefaultEntry> {
  const existing = targetDefaults[target];
  if (existing === undefined) return {};
  if (!Array.isArray(existing)) return existing;
  return existing.find((e) => e.filter === undefined) ?? {};
}

export function createNxJsonFromTurboJson(
  turboJson: Record<string, any>
): NxJsonConfiguration {
  const nxJson: NxJsonConfiguration = {
    $schema: './node_modules/nx/schemas/nx-schema.json',
  };

  // Handle global dependencies
  if (turboJson.globalDependencies?.length > 0) {
    nxJson.namedInputs = {
      sharedGlobals: turboJson.globalDependencies.map(
        (dep) => `{workspaceRoot}/${dep}`
      ),
      default: ['{projectRoot}/**/*', 'sharedGlobals'],
    };
  }

  // Handle global env vars
  if (turboJson.globalEnv?.length > 0) {
    nxJson.namedInputs = nxJson.namedInputs || {};
    nxJson.namedInputs.sharedGlobals = nxJson.namedInputs.sharedGlobals || [];
    nxJson.namedInputs.sharedGlobals.push(
      ...turboJson.globalEnv.map((env) => ({ env }))
    );
    nxJson.namedInputs.default = nxJson.namedInputs.default || [];
    if (!nxJson.namedInputs.default.includes('{projectRoot}/**/*')) {
      nxJson.namedInputs.default.push('{projectRoot}/**/*');
    }
    if (!nxJson.namedInputs.default.includes('sharedGlobals')) {
      nxJson.namedInputs.default.push('sharedGlobals');
    }
  }

  // Handle task configurations
  if (turboJson.tasks) {
    const targetDefaults: TargetDefaults = {};

    for (const [taskName, taskConfig] of Object.entries(turboJson.tasks)) {
      // Skip project-specific tasks (containing #)
      if (taskName.includes('#')) continue;

      const config = taskConfig as any;
      const entry: TargetDefaultEntry = { target: taskName };

      // Handle dependsOn
      if (config.dependsOn?.length > 0) {
        entry.dependsOn = config.dependsOn;
      }

      // Handle inputs
      if (config.inputs?.length > 0) {
        entry.inputs = config.inputs
          .map((input) => {
            if (input === '$TURBO_DEFAULT$') {
              return '{projectRoot}/**/*';
            }
            // Don't add projectRoot if it's already there or if it's an env var
            if (
              input.startsWith('{projectRoot}/') ||
              input.startsWith('{env.') ||
              input.startsWith('$')
            )
              return input;
            return `{projectRoot}/${input}`;
          })
          .map((input) => {
            // Don't add projectRoot if it's already there or if it's an env var
            if (
              input.startsWith('{projectRoot}/') ||
              input.startsWith('{env.') ||
              input.startsWith('$')
            )
              return input;
            return `{projectRoot}/${input}`;
          });
      }

      // Handle outputs
      if (config.outputs?.length > 0) {
        entry.outputs = config.outputs.map((output) => {
          // Don't add projectRoot if it's already there
          if (output.startsWith('{projectRoot}/')) return output;
          // Handle negated patterns by adding projectRoot after the !
          if (output.startsWith('!')) {
            return `!{projectRoot}/${output.slice(1)}`;
          }
          return `{projectRoot}/${output}`;
        });
      }

      // Handle cache setting - true by default in Turbo
      entry.cache = config.cache !== false;

      // Each turbo task maps to a unique key, written as the plain object
      // (unfiltered) value form.
      const { target, ...taskDefault } = entry;
      targetDefaults[target] = taskDefault;
    }

    if (Object.keys(targetDefaults).length > 0) {
      nxJson.targetDefaults = targetDefaults;
    }
  }

  /**
   * The fact that cacheDir was in use suggests the user had a reason for deviating from the default.
   * We can't know what that reason was, nor if it would still be applicable in Nx, but we can at least
   * improve discoverability of the relevant Nx option by explicitly including it with its default value.
   */
  if (turboJson.cacheDir) {
    nxJson.cacheDirectory = '.nx/cache';
  }

  const defaultBase = deduceDefaultBase();
  // Do not add defaultBase if it is inferred to be the Nx default value of main
  if (defaultBase !== 'main') {
    nxJson.defaultBase ??= defaultBase;
  }

  return nxJson;
}

export function addDepsToPackageJson(
  repoRoot: string,
  additionalPackages?: string[]
) {
  const path = joinPathFragments(repoRoot, `package.json`);
  const json = readJsonFile(path);
  if (!json.devDependencies) json.devDependencies = {};
  json.devDependencies['nx'] = nxVersion;
  if (additionalPackages) {
    for (const p of additionalPackages) {
      json.devDependencies[p] = nxVersion;
    }
  }
  writeJsonFile(path, json);
}

export function updateGitIgnore(root: string) {
  const ignorePath = join(root, '.gitignore');
  try {
    let contents = readFileSync(ignorePath, 'utf-8');
    const lines = contents.split('\n');
    let sepIncluded = false;
    if (!contents.includes('.nx/cache')) {
      if (!sepIncluded) {
        lines.push('\n');
        sepIncluded = true;
      }
      lines.push('.nx/cache');
    }
    if (!contents.includes('.nx/workspace-data')) {
      if (!sepIncluded) {
        lines.push('\n');
        sepIncluded = true;
      }
      lines.push('.nx/workspace-data');
    }
    if (!contents.includes('.nx/migrate-runs')) {
      if (!sepIncluded) {
        lines.push('\n');
        sepIncluded = true;
      }
      lines.push('.nx/migrate-runs');
    }

    writeFileSync(ignorePath, lines.join('\n'), 'utf-8');
  } catch {}
}

export function runInstall(
  repoRoot: string,
  pmc: PackageManagerCommands = getPackageManagerCommand()
) {
  approveNxBuildScriptForPnpm(repoRoot);
  try {
    execSync(pmc.install, {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      cwd: repoRoot,
      windowsHide: true,
    });
  } catch (e) {
    // Package managers put the actionable failure on their own streams —
    // pnpm, for one, prints its ERR_PNPM_* codes and their remedies to
    // stdout. Re-emit both streams and fold them into the error message so
    // error logs and telemetry name the real cause instead of a bare
    // "Command failed".
    const stdout = streamToString((e as any)?.stdout);
    const stderr = streamToString((e as any)?.stderr);
    if (stderr) process.stderr.write(stderr);
    if (stdout) process.stderr.write(stdout);
    if (e instanceof Error) {
      e.message = [e.message, stdout, stderr].filter(Boolean).join('\n');
    }
    throw e;
  }
}

/**
 * pnpm >= 10 refuses to run dependency build scripts unless they are
 * explicitly approved, and nx has a postinstall script. As of pnpm 11 an
 * unapproved build script fails the install outright (ERR_PNPM_IGNORED_BUILDS)
 * with instructions to run the interactive `pnpm approve-builds` — which
 * would eject the user from the init/import flow with no cue to come back.
 * Since nx is the dependency these flows add, approve nx's own build script
 * ahead of the install. Approving any other package's scripts remains the
 * user's decision.
 */
export function approveNxBuildScriptForPnpm(repoRoot: string): void {
  try {
    if (detectPackageManager(repoRoot) !== 'pnpm') {
      return;
    }
    const major = parseInt(
      getPackageManagerVersion('pnpm', repoRoot).split('.')[0],
      10
    );
    if (!(major >= 10)) {
      return;
    }
    const path = join(repoRoot, 'pnpm-workspace.yaml');
    const raw = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    const parsed = parseDocument(raw);
    // A present root that isn't a mapping is malformed for pnpm; bail rather
    // than clobber the user's file.
    if (parsed.contents != null && !(parsed.contents instanceof YAMLMap)) {
      return;
    }
    const doc =
      parsed.contents instanceof YAMLMap ? parsed : new Document(new YAMLMap());

    if (major >= 11) {
      // pnpm 11 reads approvals from the allowBuilds map — an install fails
      // for ANY dependency with build scripts that has no boolean entry
      // there, including packages the user already opted out of via the
      // pnpm 10 mechanism, ignoredBuiltDependencies. So in addition to
      // approving nx, migrate the user's existing opt-outs to
      // `allowBuilds: <pkg>: false` entries. Setting a value also overwrites
      // the "set this to true or false" placeholders pnpm scaffolds after a
      // failed install.
      const allowBuilds = doc.get('allowBuilds');
      if (allowBuilds != null && !(allowBuilds instanceof YAMLMap)) {
        return;
      }
      const updates: Record<string, boolean> = {};
      const configured = (name: string): unknown =>
        allowBuilds instanceof YAMLMap ? allowBuilds.get(name) : undefined;
      if (configured('nx') !== true) {
        updates['nx'] = true;
      }
      const ignored = doc.get('ignoredBuiltDependencies');
      if (ignored instanceof YAMLSeq) {
        for (const item of ignored.items) {
          const name =
            item instanceof Scalar ? String(item.value) : String(item);
          if (name !== 'nx' && typeof configured(name) !== 'boolean') {
            updates[name] = false;
          }
        }
      }
      if (Object.keys(updates).length === 0) {
        return;
      }
      if (allowBuilds instanceof YAMLMap) {
        for (const [name, value] of Object.entries(updates)) {
          doc.setIn(['allowBuilds', name], value);
        }
      } else {
        doc.set('allowBuilds', updates);
      }
    } else {
      // pnpm 10 reads approvals from the onlyBuiltDependencies list.
      const seq = doc.get('onlyBuiltDependencies');
      if (seq != null && !(seq instanceof YAMLSeq)) {
        return;
      }
      if (seq instanceof YAMLSeq) {
        const values = seq.items.map((item) =>
          item instanceof Scalar ? String(item.value) : String(item)
        );
        if (values.includes('nx')) {
          return;
        }
        seq.add('nx');
      } else {
        doc.set('onlyBuiltDependencies', ['nx']);
      }
    }
    writeFileSync(path, doc.toString());
  } catch {
    // Best-effort: if this fails, the install may still hit pnpm's
    // approve-builds gate — whose guidance runInstall now passes through.
  }
}

function streamToString(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof (raw as Buffer).toString === 'function') {
    return (raw as Buffer).toString('utf8');
  }
  return '';
}

/**
 * Coerce any thrown value into a non-empty telemetry string. The naive
 * `error.message || String(error)` yields "" for bare `new Error()`.
 */
export function toErrorString(error: unknown): string {
  if (error == null) return 'Unknown error';
  if (error instanceof Error) {
    if (error.message) return error.message;
    if (error.name && error.name !== 'Error') return error.name;
    // Drop `stack` — large and contains absolute paths (PII).
    const keys = Object.getOwnPropertyNames(error).filter((k) => k !== 'stack');
    const serialized = safeJsonStringify(error, keys);
    if (serialized && serialized !== '{}') return serialized;
    return error.name || 'Error';
  }
  if (typeof error === 'object') {
    const serialized = safeJsonStringify(error);
    if (serialized && serialized !== '{}') return serialized;
    return Object.prototype.toString.call(error);
  }
  return String(error);
}

export function readErrorStderr(error: unknown): string {
  // stdout is included as a fallback: package managers (e.g. pnpm) print
  // their error codes and remedies to stdout, and extractErrorName greps
  // this text for E*/ERR_* codes.
  return [(error as any)?.stderr, (error as any)?.stdout]
    .map(streamToString)
    .filter(Boolean)
    .join('\n');
}

export function extractErrorName(error: unknown, stderr: string): string {
  const nodeCode = (error as any)?.code;
  if (typeof nodeCode === 'string') return nodeCode;
  const m = stderr.match(/\b(E[A-Z0-9_]{2,}|ERR_[A-Z0-9_]+)\b/);
  if (m) return m[1];
  if (error instanceof Error) return error.name;
  return typeof error;
}

function safeJsonStringify(value: unknown, replacer?: string[]): string {
  try {
    return JSON.stringify(value, replacer);
  } catch {
    return '';
  }
}

export async function initCloud(
  installationSource:
    | 'nx-init'
    | 'nx-init-angular'
    | 'nx-init-monorepo'
    | 'nx-init-nest'
    | 'nx-init-npm-repo'
    | 'nx-init-turborepo'
) {
  const token = await connectWorkspaceToCloud({
    installationSource,
  });
  await printSuccessMessage(token, installationSource);
}

export function setNeverConnectToCloud(repoRoot: string): void {
  const nxJsonPath = join(repoRoot, 'nx.json');
  const nxJson = readJsonFile(nxJsonPath);
  nxJson.neverConnectToCloud = true;
  writeJsonFile(nxJsonPath, nxJson);
}

export function addVsCodeRecommendedExtensions(
  repoRoot: string,
  extensions: string[]
): void {
  const vsCodeExtensionsPath = join(repoRoot, '.vscode/extensions.json');

  if (fileExists(vsCodeExtensionsPath)) {
    const vsCodeExtensionsJson = readJsonFile(vsCodeExtensionsPath);

    vsCodeExtensionsJson.recommendations ??= [];
    extensions.forEach((extension) => {
      if (!vsCodeExtensionsJson.recommendations.includes(extension)) {
        vsCodeExtensionsJson.recommendations.push(extension);
      }
    });

    writeJsonFile(vsCodeExtensionsPath, vsCodeExtensionsJson);
  } else {
    writeJsonFile(vsCodeExtensionsPath, { recommendations: extensions });
  }
}

export function markRootPackageJsonAsNxProjectLegacy(
  repoRoot: string,
  cacheableScripts: string[],
  pmc: PackageManagerCommands
) {
  const json = readJsonFile<PackageJson>(
    joinPathFragments(repoRoot, `package.json`)
  );
  json.nx = {};
  for (let script of cacheableScripts) {
    const scriptDefinition = json.scripts[script];
    if (!scriptDefinition) {
      continue;
    }

    if (scriptDefinition.includes('&&') || scriptDefinition.includes('||')) {
      let backingScriptName = `_${script}`;
      json.scripts[backingScriptName] = scriptDefinition;
      json.scripts[script] = `nx exec -- ${pmc.run(backingScriptName, '')}`;
    } else {
      json.scripts[script] = `nx exec -- ${json.scripts[script]}`;
    }
  }
  writeJsonFile(`package.json`, json);
}

export function markPackageJsonAsNxProject(packageJsonPath: string) {
  const json = readJsonFile<PackageJson>(packageJsonPath);
  if (!json.scripts) {
    return;
  }

  json.nx = {};
  writeJsonFile(packageJsonPath, json);
}

export function printFinalMessage({
  learnMoreLink,
  appendLines,
}: {
  learnMoreLink?: string;
  appendLines?: string[];
}): void {
  output.success({
    title: '🎉 Done!',
    bodyLines: [
      `- Learn more about what to do next at ${
        learnMoreLink ?? 'https://nx.dev/getting-started/adding-to-existing'
      }`,
      ...(appendLines ?? []),
    ].filter(Boolean),
  });
}

export function isMonorepo(packageJson: PackageJson) {
  if (!!packageJson.workspaces) return true;

  try {
    const content = readFileSync('pnpm-workspace.yaml', 'utf-8');
    const { load } = require('@zkochan/js-yaml');
    const { packages } = load(content) ?? {};

    if (packages) {
      return true;
    }
  } catch {}

  if (existsSync('lerna.json')) return true;

  return false;
}
