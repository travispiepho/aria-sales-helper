/**
 * iosCheck.ts — iOS Safari compatibility checks
 * Per spec: require iOS 16.4+
 */

export function getIOSVersion(): number | null {
  const ua = navigator.userAgent;
  const match = ua.match(/OS (\d+)_(\d+)(?:_(\d+))?/);
  if (!match) return null;
  return parseFloat(`${match[1]}.${match[2]}`);
}

export function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as unknown as { MSStream?: unknown }).MSStream;
}

export function isIOSTooOld(): boolean {
  if (!isIOS()) return false;
  const version = getIOSVersion();
  if (version === null) return false;
  return version < 16.4;
}
