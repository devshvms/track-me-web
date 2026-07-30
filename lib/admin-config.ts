export interface AdminConfig {
  maintenance_mode: boolean;
  enable_live_sharing: boolean;
  enable_archive_export: boolean;
  system_announcement: string;
  force_update_version_android: string;
}

export const DEFAULT_ADMIN_CONFIG: AdminConfig = {
  maintenance_mode: false,
  enable_live_sharing: true,
  enable_archive_export: true,
  system_announcement: '',
  force_update_version_android: '',
};

export class AdminConfigValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireBoolean(
  value: unknown,
  field: keyof AdminConfig,
): boolean {
  if (typeof value !== 'boolean') {
    throw new AdminConfigValidationError(`${field} must be a boolean.`);
  }
  return value;
}

function requireString(
  value: unknown,
  field: keyof AdminConfig,
  maxLength: number,
): string {
  if (typeof value !== 'string') {
    throw new AdminConfigValidationError(`${field} must be a string.`);
  }

  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new AdminConfigValidationError(
      `${field} must be ${maxLength} characters or fewer.`,
    );
  }
  return normalized;
}

export function parseAdminConfig(value: unknown): AdminConfig {
  if (!isRecord(value)) {
    throw new AdminConfigValidationError('Configuration payload must be an object.');
  }

  return {
    maintenance_mode: requireBoolean(value.maintenance_mode, 'maintenance_mode'),
    enable_live_sharing: requireBoolean(value.enable_live_sharing, 'enable_live_sharing'),
    enable_archive_export: requireBoolean(value.enable_archive_export, 'enable_archive_export'),
    system_announcement: requireString(value.system_announcement, 'system_announcement', 500),
    force_update_version_android: requireString(
      value.force_update_version_android,
      'force_update_version_android',
      50,
    ),
  };
}

export function normalizeStoredAdminConfig(value: unknown): AdminConfig {
  if (!isRecord(value)) {
    return { ...DEFAULT_ADMIN_CONFIG };
  }

  return {
    maintenance_mode:
      typeof value.maintenance_mode === 'boolean'
        ? value.maintenance_mode
        : DEFAULT_ADMIN_CONFIG.maintenance_mode,
    enable_live_sharing:
      typeof value.enable_live_sharing === 'boolean'
        ? value.enable_live_sharing
        : DEFAULT_ADMIN_CONFIG.enable_live_sharing,
    enable_archive_export:
      typeof value.enable_archive_export === 'boolean'
        ? value.enable_archive_export
        : DEFAULT_ADMIN_CONFIG.enable_archive_export,
    system_announcement:
      typeof value.system_announcement === 'string'
        ? value.system_announcement
        : DEFAULT_ADMIN_CONFIG.system_announcement,
    force_update_version_android:
      typeof value.force_update_version_android === 'string'
        ? value.force_update_version_android
        : DEFAULT_ADMIN_CONFIG.force_update_version_android,
  };
}
