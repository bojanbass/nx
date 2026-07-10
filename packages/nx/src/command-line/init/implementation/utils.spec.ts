jest.mock('./deduce-default-base', () => ({
  deduceDefaultBase: jest.fn(() => 'main'),
}));

jest.mock('../../../utils/package-manager', () => ({
  ...jest.requireActual('../../../utils/package-manager'),
  detectPackageManager: jest.fn(() => 'pnpm'),
  getPackageManagerVersion: jest.fn(() => '11.10.0'),
}));

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse } from 'yaml';
import { NxJsonConfiguration, TargetDefaults } from '../../../config/nx-json';
import { readJsonFile, writeJsonFile } from '../../../utils/fileutils';
import {
  detectPackageManager,
  getPackageManagerVersion,
} from '../../../utils/package-manager';
import {
  approveNxBuildScriptForPnpm,
  createNxJsonFile,
  createNxJsonFromTurboJson,
  extractErrorName,
  readErrorStderr,
  toErrorString,
  upsertTargetDefaultEntry,
} from './utils';

describe('utils', () => {
  describe('createNxJsonFile', () => {
    it('reuses the same unfiltered target entry across topological and cacheable passes', () => {
      const repoRoot = mkdtempSync(join(tmpdir(), 'nx-init-utils-'));
      try {
        writeJsonFile(join(repoRoot, 'nx.json'), {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          targetDefaults: {
            build: [
              { filter: { projects: ['tag:web'] }, dependsOn: ['^filtered'] },
            ],
          },
        });

        createNxJsonFile(repoRoot, ['build'], ['build'], {});

        expect(
          readJsonFile<NxJsonConfiguration>(join(repoRoot, 'nx.json'))
        ).toMatchObject({
          targetDefaults: {
            build: [
              { filter: { projects: ['tag:web'] }, dependsOn: ['^filtered'] },
              { dependsOn: ['^build'], cache: true },
            ],
          },
        });
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it('preserves an explicit cache setting on an existing unfiltered target entry', () => {
      const repoRoot = mkdtempSync(join(tmpdir(), 'nx-init-utils-'));
      try {
        writeJsonFile(join(repoRoot, 'nx.json'), {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          targetDefaults: { build: { cache: false } },
        });

        createNxJsonFile(repoRoot, [], ['build'], {});

        expect(
          readJsonFile<NxJsonConfiguration>(join(repoRoot, 'nx.json'))
        ).toMatchObject({
          targetDefaults: { build: { cache: false } },
        });
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  });

  describe('upsertTargetDefaultEntry', () => {
    it('merges into an existing unfiltered target entry', () => {
      const targetDefaults: TargetDefaults = { build: { cache: true } };

      upsertTargetDefaultEntry(targetDefaults, 'build', {
        dependsOn: ['^build'],
      });

      expect(targetDefaults).toEqual({
        build: { cache: true, dependsOn: ['^build'] },
      });
    });

    it('appends a new unfiltered entry instead of merging into a filtered one', () => {
      const targetDefaults: TargetDefaults = {
        build: [{ filter: { projects: ['tag:web'] }, cache: true }],
      };

      upsertTargetDefaultEntry(targetDefaults, 'build', {
        dependsOn: ['^build'],
      });

      expect(targetDefaults).toEqual({
        build: [
          { filter: { projects: ['tag:web'] }, cache: true },
          { dependsOn: ['^build'] },
        ],
      });
    });
  });

  describe('createNxJsonFromTurboJson', () => {
    test.each<{
      description: string;
      turbo: Record<string, any>;
      nx: NxJsonConfiguration;
    }>([
      {
        description: 'empty turbo.json',
        turbo: {},
        nx: {
          $schema: './node_modules/nx/schemas/nx-schema.json',
        },
      },
      {
        description: 'global dependencies',
        turbo: {
          globalDependencies: ['babel.config.json'],
        },
        nx: {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          namedInputs: {
            sharedGlobals: ['{workspaceRoot}/babel.config.json'],
            default: ['{projectRoot}/**/*', 'sharedGlobals'],
          },
        },
      },
      {
        description: 'global env variables',
        turbo: {
          globalEnv: ['NEXT_PUBLIC_API', 'NODE_ENV'],
        },
        nx: {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          namedInputs: {
            sharedGlobals: [{ env: 'NEXT_PUBLIC_API' }, { env: 'NODE_ENV' }],
            default: ['{projectRoot}/**/*', 'sharedGlobals'],
          },
        },
      },
      {
        description: 'basic task configuration with dependsOn',
        turbo: {
          tasks: {
            build: {
              dependsOn: ['^build'],
            },
          },
        },
        nx: {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          targetDefaults: {
            build: {
              dependsOn: ['^build'],
              cache: true,
            },
          },
        },
      },
      {
        description: 'task configuration with outputs',
        turbo: {
          tasks: {
            build: {
              outputs: ['dist/**', '.next/**'],
            },
          },
        },
        nx: {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          targetDefaults: {
            build: {
              outputs: ['{projectRoot}/dist/**', '{projectRoot}/.next/**'],
              cache: true,
            },
          },
        },
      },
      {
        description: 'task configuration with inputs',
        turbo: {
          tasks: {
            build: {
              inputs: ['src/**/*.tsx', 'test/**/*.tsx'],
            },
          },
        },
        nx: {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          targetDefaults: {
            build: {
              inputs: [
                '{projectRoot}/src/**/*.tsx',
                '{projectRoot}/test/**/*.tsx',
              ],
              cache: true,
            },
          },
        },
      },
      {
        description: 'cache configuration',
        turbo: {
          tasks: {
            build: {
              cache: true,
            },
            dev: {
              cache: false,
            },
          },
        },
        nx: {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          targetDefaults: {
            build: { cache: true },
            dev: { cache: false },
          },
        },
      },
      {
        description: 'cache directory configuration',
        turbo: {
          cacheDir: './node_modules/.cache/turbo',
        },
        nx: {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          cacheDirectory: '.nx/cache',
        },
      },
      {
        description: 'skip project-specific task configurations',
        turbo: {
          tasks: {
            build: {
              dependsOn: ['^build'],
            },
            'docs#build': {
              dependsOn: ['^build'],
              outputs: ['www/**'],
            },
          },
        },
        nx: {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          targetDefaults: {
            build: {
              dependsOn: ['^build'],
              cache: true,
            },
          },
        },
      },
      {
        description: 'complex configuration combining multiple features',
        turbo: {
          globalDependencies: ['babel.config.json'],
          globalEnv: ['NODE_ENV'],
          cacheDir: './node_modules/.cache/turbo',
          tasks: {
            build: {
              dependsOn: ['^build'],
              outputs: ['dist/**'],
              inputs: ['src/**/*'],
              cache: true,
            },
            test: {
              dependsOn: ['build'],
              outputs: ['coverage/**'],
              cache: true,
            },
            dev: {
              cache: false,
            },
          },
        },
        nx: {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          namedInputs: {
            sharedGlobals: [
              '{workspaceRoot}/babel.config.json',
              { env: 'NODE_ENV' },
            ],
            default: ['{projectRoot}/**/*', 'sharedGlobals'],
          },
          cacheDirectory: '.nx/cache',
          targetDefaults: {
            build: {
              dependsOn: ['^build'],
              outputs: ['{projectRoot}/dist/**'],
              inputs: ['{projectRoot}/src/**/*'],
              cache: true,
            },
            test: {
              dependsOn: ['build'],
              outputs: ['{projectRoot}/coverage/**'],
              cache: true,
            },
            dev: { cache: false },
          },
        },
      },
      {
        description: 'turbo starter with $TURBO_DEFAULT$',
        turbo: {
          $schema: 'https://turbo.build/schema.json',
          ui: 'tui',
          tasks: {
            build: {
              dependsOn: ['^build'],
              inputs: ['$TURBO_DEFAULT$', '.env*'],
              outputs: ['.next/**', '!.next/cache/**'],
            },
            lint: {
              dependsOn: ['^lint'],
            },
            'check-types': {
              dependsOn: ['^check-types'],
            },
            dev: {
              cache: false,
              persistent: true,
            },
          },
        },
        nx: {
          $schema: './node_modules/nx/schemas/nx-schema.json',
          targetDefaults: {
            build: {
              dependsOn: ['^build'],
              inputs: ['{projectRoot}/**/*', '{projectRoot}/.env*'],
              outputs: [
                '{projectRoot}/.next/**',
                '!{projectRoot}/.next/cache/**',
              ],
              cache: true,
            },
            lint: {
              dependsOn: ['^lint'],
              cache: true,
            },
            'check-types': {
              dependsOn: ['^check-types'],
              cache: true,
            },
            dev: { cache: false },
          },
        },
      },
    ])('$description', ({ turbo, nx }) => {
      expect(createNxJsonFromTurboJson(turbo)).toEqual(nx);
    });
  });

  describe('toErrorString', () => {
    it('returns error.message when present', () => {
      expect(toErrorString(new Error('boom'))).toBe('boom');
    });

    it('returns "Error" for bare new Error() instead of empty string', () => {
      expect(toErrorString(new Error())).toBe('Error');
    });

    it('returns "Unknown error" for null/undefined', () => {
      expect(toErrorString(null)).toBe('Unknown error');
      expect(toErrorString(undefined)).toBe('Unknown error');
    });

    it('coerces primitive throws', () => {
      expect(toErrorString('str')).toBe('str');
      expect(toErrorString(42)).toBe('42');
    });

    it('includes own-property code when message is empty', () => {
      const e = new Error('') as Error & { code?: string };
      e.code = 'E404';
      expect(toErrorString(e)).toContain('E404');
    });

    it('serializes plain objects', () => {
      expect(toErrorString({ foo: 'bar' })).toBe('{"foo":"bar"}');
    });

    it('falls through to toString() for unserializable objects', () => {
      const circular: any = {};
      circular.self = circular;
      expect(toErrorString(circular)).toBe('[object Object]');
    });
  });

  describe('readErrorStderr', () => {
    it('returns string stderr as-is', () => {
      expect(readErrorStderr({ stderr: 'hello' })).toBe('hello');
    });

    it('decodes Buffer stderr to utf8', () => {
      expect(readErrorStderr({ stderr: Buffer.from('boom', 'utf8') })).toBe(
        'boom'
      );
    });

    it('returns "" when stderr is absent or nullish', () => {
      expect(readErrorStderr({})).toBe('');
      expect(readErrorStderr(null)).toBe('');
      expect(readErrorStderr({ stderr: null })).toBe('');
    });

    it('includes stdout, where package managers print their error codes', () => {
      expect(readErrorStderr({ stdout: 'ERR_PNPM_IGNORED_BUILDS' })).toBe(
        'ERR_PNPM_IGNORED_BUILDS'
      );
      expect(readErrorStderr({ stderr: 'boom', stdout: 'details' })).toBe(
        'boom\ndetails'
      );
    });
  });

  describe('approveNxBuildScriptForPnpm', () => {
    let repoRoot: string;
    const workspaceYaml = () => join(repoRoot, 'pnpm-workspace.yaml');

    beforeEach(() => {
      repoRoot = mkdtempSync(join(tmpdir(), 'nx-init-approve-builds-'));
      (detectPackageManager as jest.Mock).mockReturnValue('pnpm');
      (getPackageManagerVersion as jest.Mock).mockReturnValue('11.10.0');
    });

    afterEach(() => {
      rmSync(repoRoot, { recursive: true, force: true });
    });

    it('creates pnpm-workspace.yaml with allowBuilds.nx for pnpm >= 11', () => {
      approveNxBuildScriptForPnpm(repoRoot);

      expect(parse(readFileSync(workspaceYaml(), 'utf-8'))).toEqual({
        allowBuilds: { nx: true },
      });
    });

    it('overwrites the placeholder pnpm scaffolds after a failed install, preserving other entries and comments', () => {
      writeFileSync(
        workspaceYaml(),
        [
          '# team notes',
          'allowBuilds:',
          '  nx: set this to true or false',
          '  sharp: false',
          'packages:',
          "  - 'apps/*'",
          '',
        ].join('\n')
      );

      approveNxBuildScriptForPnpm(repoRoot);

      const contents = readFileSync(workspaceYaml(), 'utf-8');
      expect(contents).toContain('# team notes');
      expect(parse(contents)).toEqual({
        allowBuilds: { nx: true, sharp: false },
        packages: ['apps/*'],
      });
    });

    it('migrates ignoredBuiltDependencies to allowBuilds: false entries for pnpm >= 11', () => {
      writeFileSync(
        workspaceYaml(),
        [
          'allowBuilds:',
          '  nx: set this to true or false',
          '  sharp: set this to true or false',
          'ignoredBuiltDependencies:',
          '  - sharp',
          '  - unrs-resolver',
          '',
        ].join('\n')
      );

      approveNxBuildScriptForPnpm(repoRoot);

      expect(parse(readFileSync(workspaceYaml(), 'utf-8'))).toEqual({
        allowBuilds: { nx: true, sharp: false, 'unrs-resolver': false },
        ignoredBuiltDependencies: ['sharp', 'unrs-resolver'],
      });
    });

    it('does not override explicit boolean allowBuilds entries during migration', () => {
      writeFileSync(
        workspaceYaml(),
        [
          'allowBuilds:',
          '  sharp: true',
          'ignoredBuiltDependencies:',
          '  - sharp',
          '',
        ].join('\n')
      );

      approveNxBuildScriptForPnpm(repoRoot);

      expect(parse(readFileSync(workspaceYaml(), 'utf-8'))).toEqual({
        allowBuilds: { nx: true, sharp: true },
        ignoredBuiltDependencies: ['sharp'],
      });
    });

    it('does not migrate ignoredBuiltDependencies for pnpm 10, where it is still the native mechanism', () => {
      (getPackageManagerVersion as jest.Mock).mockReturnValue('10.18.0');
      writeFileSync(
        workspaceYaml(),
        ['ignoredBuiltDependencies:', '  - sharp', ''].join('\n')
      );

      approveNxBuildScriptForPnpm(repoRoot);

      expect(parse(readFileSync(workspaceYaml(), 'utf-8'))).toEqual({
        ignoredBuiltDependencies: ['sharp'],
        onlyBuiltDependencies: ['nx'],
      });
    });

    it('appends nx to onlyBuiltDependencies for pnpm 10, without duplicating', () => {
      (getPackageManagerVersion as jest.Mock).mockReturnValue('10.18.0');
      writeFileSync(
        workspaceYaml(),
        ['onlyBuiltDependencies:', '  - esbuild', ''].join('\n')
      );

      approveNxBuildScriptForPnpm(repoRoot);
      approveNxBuildScriptForPnpm(repoRoot);

      expect(parse(readFileSync(workspaceYaml(), 'utf-8'))).toEqual({
        onlyBuiltDependencies: ['esbuild', 'nx'],
      });
    });

    it('does nothing for pnpm < 10 or other package managers', () => {
      (getPackageManagerVersion as jest.Mock).mockReturnValue('9.15.9');
      approveNxBuildScriptForPnpm(repoRoot);
      expect(existsSync(workspaceYaml())).toBe(false);

      (detectPackageManager as jest.Mock).mockReturnValue('npm');
      (getPackageManagerVersion as jest.Mock).mockReturnValue('11.10.0');
      approveNxBuildScriptForPnpm(repoRoot);
      expect(existsSync(workspaceYaml())).toBe(false);
    });

    it('leaves the file untouched when nx is already approved or the file is malformed', () => {
      const approved = 'allowBuilds:\n  nx: true\n';
      writeFileSync(workspaceYaml(), approved);
      approveNxBuildScriptForPnpm(repoRoot);
      expect(readFileSync(workspaceYaml(), 'utf-8')).toBe(approved);

      const malformed = '- just\n- a\n- list\n';
      writeFileSync(workspaceYaml(), malformed);
      approveNxBuildScriptForPnpm(repoRoot);
      expect(readFileSync(workspaceYaml(), 'utf-8')).toBe(malformed);
    });
  });

  describe('extractErrorName', () => {
    it('prefers Node e.code when set', () => {
      expect(extractErrorName({ code: 'EACCES' }, 'stderr E404')).toBe(
        'EACCES'
      );
    });

    it.each([
      ['npm error code E404', 'E404'],
      ['npm error code ERESOLVE', 'ERESOLVE'],
      ['npm error code EINTEGRITY sha512 failure', 'EINTEGRITY'],
      ['ERR_PNPM_PEER_DEP_ISSUES Unmet peer deps', 'ERR_PNPM_PEER_DEP_ISSUES'],
    ])('extracts %s as %s', (stderr, expected) => {
      expect(extractErrorName({}, stderr)).toBe(expected);
    });

    it('falls back to error.name for plain Errors', () => {
      expect(extractErrorName(new TypeError('x'), '')).toBe('TypeError');
    });

    it('returns typeof for non-Error throws', () => {
      expect(extractErrorName('str', '')).toBe('string');
      expect(extractErrorName(42, '')).toBe('number');
    });
  });
});
