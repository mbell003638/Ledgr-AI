type VoiceAssistantListener = () => void;

const listeners = new Set<VoiceAssistantListener>();

/**
 * Starts the voice dock on the screen the user is looking at.
 *
 * More than one VoiceFab can be mounted at once: the tab layout keeps its own
 * mounted underneath any pushed route, so a screen that mounts its own dock
 * (Ask AI) would otherwise start two recorders on the same tap. Sets preserve
 * insertion order, so the most recently mounted listener is the top-most
 * screen, and only it is notified.
 */
export function requestVoiceAssistant() {
  const active = Array.from(listeners).pop();
  active?.();
}

export function subscribeToVoiceAssistantRequest(listener: VoiceAssistantListener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
