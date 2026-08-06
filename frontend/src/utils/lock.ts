/**
 * Device-lock gate for destructive / sensitive actions.
 *
 * Uses the phone's own biometric or device passcode (fingerprint / face / PIN)
 * via expo-local-authentication — there is NO separate app password to set or
 * forget. Call `requireAuth()` before Change / Delete / Reset operations.
 *
 * Behavior:
 *  - Disabled in Settings: the action proceeds without a prompt.
 *  - Enabled: an enrolled device PIN/biometric is required and failures deny access.
 */

import * as LocalAuthentication from 'expo-local-authentication';
import { getSettings } from '@/src/db/local';

export async function deviceHasLock(): Promise<boolean> {
  try {
    // SecurityLevel.SECRET includes a device PIN/password even when biometric
    // hardware is unavailable. This matches authenticateAsync's device fallback.
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    return level >= LocalAuthentication.SecurityLevel.SECRET;
  } catch {
    return false;
  }
}

/**
 * Prompt for device authentication before a sensitive action.
 * Returns true if App Lock is disabled or device authentication succeeds.
 */
export async function requireAuth(reason = 'Confirm your identity to continue'): Promise<boolean> {
  try {
    const settings = await getSettings();
    if (!settings.lockEnabled) return true;

    const available = await deviceHasLock();
    if (!available) return false;

    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return res.success;
  } catch {
    return false;
  }
}
