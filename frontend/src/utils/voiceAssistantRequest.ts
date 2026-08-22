type VoiceAssistantListener = () => void;

const listeners = new Set<VoiceAssistantListener>();

export function requestVoiceAssistant() {
  listeners.forEach((listener) => listener());
}

export function subscribeToVoiceAssistantRequest(listener: VoiceAssistantListener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
