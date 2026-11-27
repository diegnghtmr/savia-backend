export interface NotificationPreferences {
  readonly channels: {
    readonly in_app: boolean;
    readonly push: boolean;
    readonly email: boolean;
  };
  readonly quietHours: {
    readonly start: string;
    readonly end: string;
    readonly timezone: string;
  } | null;
  readonly digestEnabled: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  channels: { in_app: true, push: true, email: true },
  quietHours: null,
  digestEnabled: true,
};

const LOCAL_TIME = /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/;

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
    ? (value as Record<string, unknown>)
    : undefined;
}

function isLocalTime(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length === 5 && LOCAL_TIME.test(value)
  );
}

export function parseNotificationPreferences(
  value: unknown,
): NotificationPreferences | undefined {
  const body = exactObject(value, ['channels', 'quietHours', 'digestEnabled']);
  const channels = exactObject(body?.channels, ['in_app', 'push', 'email']);
  if (
    !body ||
    !channels ||
    typeof channels.in_app !== 'boolean' ||
    typeof channels.push !== 'boolean' ||
    typeof channels.email !== 'boolean' ||
    typeof body.digestEnabled !== 'boolean'
  )
    return undefined;
  const parsed = {
    channels: {
      in_app: channels.in_app,
      push: channels.push,
      email: channels.email,
    },
    digestEnabled: body.digestEnabled,
  };
  if (body.quietHours === null) return { ...parsed, quietHours: null };
  const quiet = exactObject(body.quietHours, ['start', 'end', 'timezone']);
  if (
    !quiet ||
    !isLocalTime(quiet.start) ||
    !isLocalTime(quiet.end) ||
    typeof quiet.timezone !== 'string' ||
    quiet.timezone.length === 0
  )
    return undefined;
  return {
    ...parsed,
    quietHours: {
      start: quiet.start,
      end: quiet.end,
      timezone: quiet.timezone,
    },
  };
}

export interface PushDeviceRequest {
  readonly expoPushToken: string;
  readonly platform: 'ios' | 'android';
  readonly appVersion: string;
}

const EXPO_TOKEN = /^(?:ExpoPushToken|ExponentPushToken)\[[A-Za-z0-9_-]+\]$/;

export function parsePushDeviceRequest(
  value: unknown,
): PushDeviceRequest | undefined {
  const body = exactObject(value, ['expoPushToken', 'platform', 'appVersion']);
  if (body === undefined) return undefined;
  const { expoPushToken, platform, appVersion } = body;
  if (
    typeof expoPushToken !== 'string' ||
    expoPushToken.length > 255 ||
    !expoPushToken.endsWith(']') ||
    !EXPO_TOKEN.test(expoPushToken) ||
    (platform !== 'ios' && platform !== 'android') ||
    typeof appVersion !== 'string' ||
    appVersion.length === 0 ||
    appVersion.includes('\0') ||
    [...appVersion].length > 64
  )
    return undefined;
  return { expoPushToken, platform, appVersion };
}
