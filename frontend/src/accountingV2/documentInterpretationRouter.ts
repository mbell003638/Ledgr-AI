import type { OcrProvider } from '../db/ai';
import { parseLocalDocumentText, type LocalDocumentParserOptions, type LocalDocumentParseResult } from './localDocumentParser';

export type DocumentAnalysisInput = { base64?: string; mimeType?: string; text?: string; uri?: string };
export type DocumentAnalysisRoute = {
  analysis: Record<string, unknown>;
  source: 'local' | 'cloud';
  extractedText?: string;
  notice?: string;
  pending?: Extract<LocalDocumentParseResult, { kind: 'clarification' }>;
};

type RouteRequest = {
  input: DocumentAnalysisInput;
  mode: OcrProvider;
  hasCloudAI: boolean;
  recognizeLocal: (uri: string) => Promise<string>;
  analyzeCloud: (input: DocumentAnalysisInput) => Promise<unknown>;
  parserOptions?: LocalDocumentParserOptions;
};

function localRoute(text: string, options?: LocalDocumentParserOptions): DocumentAnalysisRoute | null {
  const parsed = parseLocalDocumentText(text, options);
  if (parsed.kind === 'unsupported') return null;
  return {
    analysis: parsed.analysis as Record<string, unknown>,
    source: 'local',
    extractedText: parsed.sourceText,
    ...(parsed.kind === 'clarification' ? { notice: parsed.question, pending: parsed } : {}),
  };
}

/** Routes OCR and document interpretation without ever posting ledger data. */
export async function analyzeDocumentLocalFirst(request: RouteRequest): Promise<DocumentAnalysisRoute> {
  if (request.mode === 'cloud') {
    return { analysis: await request.analyzeCloud(request.input) as Record<string, unknown>, source: 'cloud' };
  }

  let extractedText = request.input.text?.trim() || '';
  let localFailure = '';
  if (!extractedText && request.input.uri && request.input.mimeType?.startsWith('image/')) {
    try { extractedText = await request.recognizeLocal(request.input.uri); }
    catch (error: any) { localFailure = error?.message || 'Local OCR could not read this image.'; }
  }

  if (extractedText) {
    const local = localRoute(extractedText, request.parserOptions);
    if (local && (request.mode === 'android-device' || !local.notice || !request.hasCloudAI)) return local;
    if (local && !request.hasCloudAI) return local;
    if (!local) localFailure = 'Local OCR text did not contain enough accounting information.';
  } else if (!localFailure) {
    localFailure = request.input.mimeType === 'application/pdf'
      ? 'On-device PDF OCR is unavailable. Upload page images or paste the PDF text.'
      : 'Local OCR needs an Android image URI or pasted document text.';
  }

  if (request.mode === 'android-device') {
    throw new Error(localFailure || 'The document needs more information before Ledgr can prepare a draft.');
  }
  if (!request.hasCloudAI) {
    throw new Error(`${localFailure || 'Local document extraction was insufficient'} Cloud fallback is optional; configure an AI key or edit and paste the document text.`);
  }
  return { analysis: await request.analyzeCloud(request.input) as Record<string, unknown>, source: 'cloud', ...(extractedText ? { extractedText } : {}) };
}
