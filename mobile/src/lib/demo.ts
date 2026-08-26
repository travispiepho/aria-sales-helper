/**
 * Compile-time public switch for the isolated, testing-only APK.
 * Only the exact string "true" enables demo behavior; production and all
 * existing EAS profiles leave it unset and therefore retain normal auth/API.
 */
export const IS_DEMO_MODE = process.env.EXPO_PUBLIC_DEMO_MODE === 'true';

export const DEMO_DISABLED_MESSAGE =
  'Disabled in ARIA TEST. This offline demo cannot contact ARIA services or change production data.';
