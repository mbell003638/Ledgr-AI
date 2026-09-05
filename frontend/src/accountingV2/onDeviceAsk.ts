import { isExplicitBookMutationRequest, isOnDeviceInterpretation } from '../db/ai';
import {
  bestOnDevicePack,
  interpretNeedleAskAction,
  runOptionalOnDeviceModel,
} from '../utils/onDeviceLlm';
import { OPTIONAL_ON_DEVICE_MODELS } from './onDeviceTools';

function trimSnapshot(dataContext: string): string {
  return dataContext.length > 4000 ? `${dataContext.slice(0, 4000)}\n[truncated]` : dataContext;
}

function parseAskJson(raw: string): { answer: string; action: { type: string; params: Record<string, unknown> } | null } | null {
  const text = raw.trim();
  const json = text.startsWith('{') ? text : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    const action = parsed.action && parsed.action.type ? parsed.action : null;
    return { answer: String(parsed.answer || '').trim(), action };
  } catch { return null; }
}

/** Device-only / device-first Ask: Needle for mutations, optional Gemma for answers. */
export async function askBooksOnDevice(
  cfg: Parameters<typeof isOnDeviceInterpretation>[0],
  question: string,
  dataContext: string,
): Promise<{ answer: string; action: any } | null> {
  const mutation = isExplicitBookMutationRequest(question);
  if (mutation) {
    const action = await interpretNeedleAskAction(question);
    if (action) {
      return { answer: 'I prepared this Ledgr change on the phone for your confirmation.', action };
    }
  }

  const installed = await bestOnDevicePack(['text']);
  if (installed) {
    const prompt = [
      'You are Ledgr on-device. Answer from the snapshot only. Return JSON {answer, action|null}.',
      'Never invent IDs. Do not delete inventory_count, customer, or supplier.',
      `SNAPSHOT:\n${trimSnapshot(dataContext)}`,
      `USER: ${question}`,
    ].join('\n');
    try {
      const parsed = parseAskJson(await runOptionalOnDeviceModel({ id: installed.id, prompt }));
      if (parsed) {
        if (parsed.action && !mutation) parsed.action = null;
        return parsed;
      }
    } catch {
      /* fall through */
    }
  }

  if (!isOnDeviceInterpretation(cfg)) return null;
  if (mutation) {
    return { answer: 'I could not map that to a Ledgr action on this phone. Add the amount and party, or download an on-device model pack in Advanced Settings.', action: null };
  }
  const visionHint = OPTIONAL_ON_DEVICE_MODELS.find((row) => row.vision)?.label;
  return {
    answer: installed
      ? 'I could not answer from the on-device model. Try a shorter question about cash, profit, or a named party.'
      : `On-device Ask can record simple entries with Needle. Download ${visionHint || 'Gemma 4 E2B'} in Advanced Settings for explanations, or use Reports.`,
    action: null,
  };
}
