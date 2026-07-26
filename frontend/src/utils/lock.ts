/**
 * Device-lock gate for destructive / sensitive actions.
 *
 * Uses the phone's own biometric or device passcode (fingerprint / face / PIN)
 * via expo-local-authentication — there is NO separate app password to set or
 * forget. Call `requireAuth()` before Change / Delete / Reset operations.
 *
 * Behavior:
 *  - If the device has no biometric/PIN enrolled, we DON'T hard-block the user
 *    out of their own data — we allow the action (there's nothing to
 *    authenticate against). This avoids locking someone out permanently.
 *  - If enrolled, we prompt; the action proceeds only on success.
 */

import * as LocalAuthentication from 'expo-local-authentication';

export async function deviceHasLock(): Promise<boolean> {
  try {
    const hasHardware = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return hasHardware && enrolled;
  } catch {
    return false;
  }
}

/**
 * Prompt for device authentication before a sensitive action.
 * Returns true if the user may proceed (authenticated, or no lock available).
 */
export async function requireAuth(reason = 'Confirm your identity to continue'): Promise<boolean> {
  try {
    const available = await deviceHasLock();
    if (!available) {
      // No enrolled lock — allow rather than trap the user out of their data.
      return true;
    }
    const res = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return res.success;
  } catch {
    // On any unexpected failure, fail safe by allowing (don't trap the user).
    return true;
  }
}
