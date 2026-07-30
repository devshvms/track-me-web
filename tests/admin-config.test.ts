import assert from 'node:assert';
import {
  AdminConfigValidationError,
  DEFAULT_ADMIN_CONFIG,
  normalizeStoredAdminConfig,
  parseAdminConfig,
} from '../lib/admin-config';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    process.stdout.write(`  ✗ ${name}\n`);
  }
}

const validConfig = {
  maintenance_mode: false,
  enable_live_sharing: true,
  enable_archive_export: true,
  system_announcement: 'Welcome back',
  force_update_version_android: '1.6.1',
};

test('parseAdminConfig accepts and normalizes the admin form payload', () => {
  assert.deepEqual(
    parseAdminConfig({
      ...validConfig,
      system_announcement: '  Welcome back  ',
    }),
    validConfig,
  );
});

test('parseAdminConfig rejects missing or incorrectly typed switches', () => {
  assert.throws(
    () => parseAdminConfig({ ...validConfig, maintenance_mode: 'false' }),
    AdminConfigValidationError,
  );
  assert.throws(
    () => parseAdminConfig({ ...validConfig, enable_archive_export: undefined }),
    AdminConfigValidationError,
  );
});

test('parseAdminConfig enforces text length limits', () => {
  assert.throws(
    () => parseAdminConfig({ ...validConfig, system_announcement: 'x'.repeat(501) }),
    /500 characters or fewer/,
  );
  assert.throws(
    () => parseAdminConfig({ ...validConfig, force_update_version_android: 'x'.repeat(51) }),
    /50 characters or fewer/,
  );
});

test('normalizeStoredAdminConfig supplies safe defaults for a missing document', () => {
  assert.deepEqual(normalizeStoredAdminConfig(null), DEFAULT_ADMIN_CONFIG);
});

test('normalizeStoredAdminConfig preserves valid stored fields and defaults invalid ones', () => {
  assert.deepEqual(
    normalizeStoredAdminConfig({
      maintenance_mode: true,
      enable_live_sharing: false,
      enable_archive_export: 'yes',
      system_announcement: 'Maintenance tonight',
      force_update_version_android: 161,
    }),
    {
      maintenance_mode: true,
      enable_live_sharing: false,
      enable_archive_export: true,
      system_announcement: 'Maintenance tonight',
      force_update_version_android: '',
    },
  );
});

process.stdout.write(`\nadmin config: ${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  failures.forEach((failure) => process.stderr.write(`  FAIL ${failure}\n`));
  process.exit(1);
}
