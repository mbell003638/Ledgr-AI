import { isExplicitBookMutationRequest, isOnDeviceInterpretation } from '../db/ai';
import {
  interpretNeedleAskAction,
  listOptionalOnDeviceModels,
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

/**
 * Small on-device models answer "how are you?" in prose, not JSON. Prose is a
 * real answer, so keep it rather than discarding the reply for the wrong shape.
 */
function plainAnswer(raw: string): string {
  const text = String(raw || '').replace(/```[a-z]*\n?|```/gi, '').trim();
  if (!text || text.startsWith('{')) return '';
  return text.length > 1200 ? `${text.slice(0, 1200).trimEnd()}\u2026` : text;
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

  const installed = (await listOptionalOnDeviceModels()).find((model) => model.installed);
  if (installed) {
    const prompt = [
      'You are Ledgr, a helpful assistant running privately on the phone.',
      'Ledgr is an offline-first double-entry bookkeeping app for small shops: it records sales, expenses,',
      'bills, payments, invoices and stock, and produces profit and loss, balance sheet and trial balance',
      'reports. It works with no internet, keeps the books on this device, and can sync to another phone.',
      'If asked what you or the app can do, answer from that description.',
      'If the question is about this business, answer from the SNAPSHOT and never invent figures or IDs.',
      'If it is a greeting, small talk, or general knowledge, simply answer it in your own words.',
      'Do not delete inventory_count, customer, or supplier.',
      'Prefer JSON {answer, action|null}; plain text is accepted too.',
      `SNAPSHOT:\n${trimSnapshot(dataContext)}`,
      `USER: ${question}`,
    ].join('\n');
    try {
      const raw = await runOptionalOnDeviceModel({ id: installed.id, prompt });
      const parsed = parseAskJson(raw);
      if (parsed) {
        if (parsed.action && !mutation) parsed.action = null;
        if (parsed.answer || parsed.action) return parsed;
      }
      const prose = plainAnswer(raw);
      if (prose) return { answer: prose, action: null };
    } catch {
      /* fall through */
    }
  }

  if (!isOnDeviceInterpretation(cfg)) return null;
  if (mutation) {
    return { answer: 'I could not map that to a Ledgr action on this phone. Add the amount and party, or download Gemma 3 1B in Advanced Settings.', action: null };
  }
  const visionHint = OPTIONAL_ON_DEVICE_MODELS.find((row) => row.vision)?.label;
  return {
    answer: installed
      ? 'The on-device model returned nothing usable. Try asking again, or keep the question shorter.'
      : `On-device Ask can record simple entries with Needle. Download ${visionHint || 'Gemma 4 E2B'} in Advanced Settings for explanations, or use Reports.`,
    action: null,
  };
}
