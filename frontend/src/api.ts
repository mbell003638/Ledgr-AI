import AsyncStorage from '@react-native-async-storage/async-storage';
import { storage } from '@/src/utils/storage';
import { bumpDataVersion } from '@/src/utils/dataVersion';
import { localTodayIso } from '@/src/utils/dateValidation';
import { round2 } from '@/src/money';
import * as db from '@/src/db/local';
import * as ai from '@/src/db/ai';
import type { AIConfig } from '@/src/db/ai';
import { V2AppService, createAppWriteRouter, createAppMutationRouter, createCloseBooksRouter, stablePartyId, type V2ClosingBalancesImportInput, type V2ScanPartyRequest, type V2ScanTransactionImportInput } from '@/src/accountingV2/appService';
import { initializeV2Book, accountingBookVersion } from '@/src/accountingV2/appBootstrap';
import { V2BookConfigRepository, type V2BookConfigUpdate } from '@/src/accountingV2/bookConfigRepository';
import { ensureV2BookPrefs, writeV2BookPrefs } from '@/src/accountingV2/optionalModules';
import { assertFeatureDisableAllowed, getV2FeatureDisableBlockers, type FeatureDisableBlockers } from '@/src/accountingV2/featureDisableGuards';
import { getEnabledFeatures, type FeatureKey } from '@/src/utils/featureFlags';
import { readBookHealth, unavailableBookHealth } from '@/src/utils/bookHealth';
import type { PersonaId } from '@/src/accountingV2/config';
import { getV2Dashboard } from '@/src/accountingV2/v2Dashboard';
import { partnershipDisplayFromReports } from './accountingV2/reports';
import { buildPersistentV2Reports } from '@/src/accountingV2/persistentReports';
import { resetAllV2AccountingData, factoryResetV2Data } from '@/src/accountingV2/resetBook';
import { V2InvestorLedgerService, type InvestorLedgerDetail } from '@/src/accountingV2/investorLedgerService';
import { V2SqlRepository } from '@/src/accountingV2/repository';
import { resolveWriteLocationId } from '@/src/accountingV2/services/locationDomainService';
import { V2DocumentService } from '@/src/accountingV2/documentService';
import { v2Services } from '@/src/accountingV2/runtime';
import { configureSync, disableSync, enableSync, getSyncStatus, markSyncRecoveryRequired, retrySyncNow, syncNow, withSyncedMutation, type SyncMutation } from '@/src/sync/coordinator';
import { listOpenSyncConflicts, listSyncCorrectionAccounts, resolveSyncConflict as resolveSyncConflictDecision, type ConflictResolutionType } from '@/src/sync/conflicts';
import { installServerSnapshot, publishServerSnapshot, verifyProjectionCheckpoint } from '@/src/sync/recovery';
import { BOOK_PROJECTION_SCHEMA_VERSION, exportBookProjection, hashBookProjection, installBookProjection } from '@/src/sync/projection';
import type { SyncOperation } from '@/src/sync/protocol';
import { authorizeSyncOidc as runSyncOidcAuthorization } from '@/src/sync/oidc';
import {
  listBooks as beListBooks,
  activeBookId as beActiveBookId,
  activeSqlRunner,
  setActiveBook as beSetActiveBook,
  createBook as beCreateBook,
  renameBook as beRenameBook,
  deleteBook as beDeleteBook,
  clearAskHistory as beClearAskHistory,
  resetBooksAndActiveBook as beResetBooksAndActiveBook,
  type BookMeta,
} from '@/src/db/backend';

const AI_PROVIDER_KEY = 'ai_provider';
const AI_API_KEY_KEY  = 'ai_api_key';
const AI_MODEL_KEY    = 'ai_model';
const AI_VISION_MODEL_KEY = 'ai_vision_model';
const AI_TRANSCRIPTION_MODEL_KEY = 'ai_transcription_model';
const AI_TRANSCRIPTION_BASE_URL_KEY = 'ai_transcription_base_url';
const AI_TRANSCRIPTION_API_KEY_KEY = 'ai_transcription_api_key';
const AI_BASE_URL_KEY = 'ai_base_url';
const AI_TRANSFER_CONSENT_PREFIX = 'ledgr:ai-transfer-consent:';

// User-preference + UI-customization AsyncStorage keys that live OUTSIDE the
// per-book settings blob. A factory reset must wipe these too so the device is
// returned to a truly pristine state (the user explicitly wants preferences
// gone, not preserved). Mirrors the keys written by:
//   - ThemeContext.tsx: 'theme_mode', 'animations_enabled'
//   - app/(tabs)/index.tsx: 'ledgr_tile_order', 'ledgr_tile_usage'
const THEME_MODE_KEY        = 'theme_mode';
const ANIMATIONS_ENABLED_KEY = 'animations_enabled';
const TILE_ORDER_KEY        = 'ledgr_tile_order';
const TILE_USAGE_KEY        = 'ledgr_tile_usage';
// Exported so the reset UI (advanced-settings) can assert/reset in lockstep and
// tests can enumerate the exact device-level keys a factory reset must clear.
export const FACTORY_RESET_PREF_KEYS = [
  THEME_MODE_KEY,
  ANIMATIONS_ENABLED_KEY,
  TILE_ORDER_KEY,
  TILE_USAGE_KEY,
] as const;

export async function getAIConfig(): Promise<AIConfig> {
  const [provider, secureKey, storedKey, model, visionModel, transcriptionModel, transcriptionBaseUrl, secureTranscriptionKey, baseUrl] = await Promise.all([
    AsyncStorage.getItem(AI_PROVIDER_KEY),
    storage.secureGet(AI_API_KEY_KEY, ''),
    AsyncStorage.getItem(AI_API_KEY_KEY),
    AsyncStorage.getItem(AI_MODEL_KEY),
    AsyncStorage.getItem(AI_VISION_MODEL_KEY),
    AsyncStorage.getItem(AI_TRANSCRIPTION_MODEL_KEY),
    AsyncStorage.getItem(AI_TRANSCRIPTION_BASE_URL_KEY),
    storage.secureGet(AI_TRANSCRIPTION_API_KEY_KEY, ''),
    AsyncStorage.getItem(AI_BASE_URL_KEY),
  ]);
  const resolvedKey = secureKey || storedKey || '';
  if (resolvedKey && !secureKey) {
    const migrated = await storage.secureSet(AI_API_KEY_KEY, resolvedKey);
    if (migrated) await AsyncStorage.removeItem(AI_API_KEY_KEY);
  }
  return {
    provider: ai.normalizeProviderId(provider),
    apiKey: resolvedKey,
    model: model ?? ai.DEFAULT_GEMINI_MODEL,
    visionModel: visionModel ?? undefined,
    transcriptionModel: transcriptionModel ?? undefined,
    transcriptionBaseUrl: transcriptionBaseUrl ?? undefined,
    transcriptionApiKey: secureTranscriptionKey || undefined,
    baseUrl: baseUrl ?? undefined,
  };
}

export async function setAIConfig(cfg: Partial<AIConfig>) {
  const ops: Promise<unknown>[] = [];
  if (cfg.provider !== undefined) ops.push(AsyncStorage.setItem(AI_PROVIDER_KEY, cfg.provider));
  if (cfg.apiKey !== undefined) {
    const secureOk = cfg.apiKey
      ? await storage.secureSet(AI_API_KEY_KEY, cfg.apiKey)
      : await storage.secureRemove(AI_API_KEY_KEY);
    if (secureOk === false) throw new Error('Could not securely save your AI API key on this device. Please try again.');
    ops.push(AsyncStorage.removeItem(AI_API_KEY_KEY));
  }
  if (cfg.transcriptionApiKey !== undefined) {
    const secureOk = cfg.transcriptionApiKey
      ? await storage.secureSet(AI_TRANSCRIPTION_API_KEY_KEY, cfg.transcriptionApiKey)
      : await storage.secureRemove(AI_TRANSCRIPTION_API_KEY_KEY);
    if (secureOk === false) throw new Error('Could not securely save your voice API key on this device. Please try again.');
    ops.push(AsyncStorage.removeItem(AI_TRANSCRIPTION_API_KEY_KEY));
  }
  if (cfg.model !== undefined) ops.push(AsyncStorage.setItem(AI_MODEL_KEY, cfg.model));
  if (cfg.visionModel !== undefined) ops.push(AsyncStorage.setItem(AI_VISION_MODEL_KEY, cfg.visionModel));
  if (cfg.transcriptionModel !== undefined) ops.push(AsyncStorage.setItem(AI_TRANSCRIPTION_MODEL_KEY, cfg.transcriptionModel));
  if (cfg.transcriptionBaseUrl !== undefined) ops.push(AsyncStorage.setItem(AI_TRANSCRIPTION_BASE_URL_KEY, ai.validateAIBaseUrl(cfg.transcriptionBaseUrl)));
  if (cfg.baseUrl !== undefined) ops.push(AsyncStorage.setItem(AI_BASE_URL_KEY, ai.validateAIBaseUrl(cfg.baseUrl)));
  await Promise.all(ops);
}
// Convenience aliases used by the current voice and bill screens.
export async function getGeminiKey(): Promise<string> { return (await getAIConfig()).apiKey; }
export async function setGeminiKey(v: string) { await setAIConfig({ apiKey: v }); }
export async function getGeminiModel(): Promise<string> { return (await getAIConfig()).model; }
export async function setGeminiModel(v: string) { await setAIConfig({ model: v }); }

// ---------- reconcile helper (matching logic in JS) ----------
// Works for BOTH a supplier (compare their statement to our bills/payments) and a
// customer/debtor (compare their statement to our invoices/receipts). `party`
// selects which ledger side to pull; `partyId` is the supplier or debtor id.
async function reconcileStatement(
  imageBase64: string,
  partyId: string,
  mimeType = 'image/jpeg',
  party: 'supplier' | 'customer' = 'supplier',
) {
  const extracted = await ai.reconcileStatementAI(await getAIConfig(), imageBase64, mimeType);

  let ourBills: any[] = [], ourPayments: any[] = [];
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const service = new V2AppService(runner);
  if (!await service.activeContext()) throw new Error('No active versioned V2 book with an open accounting period');
  if (!partyId) throw new Error('Choose a customer or supplier before reconciling');
  const detail: any = await service.getPartyDetail(partyId, party);
  if (!detail) throw new Error(`${party === 'customer' ? 'Customer' : 'Supplier'} was not found in the active V2 book`);
  if (party === 'customer') {
    ourBills = (detail.statement?.ledger || []).filter((item: any) => item.kind === 'invoice').map((item: any) => ({ amount: item.debit, date: item.date, reference: item.ref }));
    ourPayments = (detail.payments || []).map((item: any) => ({ amount: item.amount, date: item.date }));
  } else {
    ourBills = detail.bills || [];
    ourPayments = detail.payments || [];
  }

  const daysBetween = (a: string, b: string) => {
    const A = new Date(a); const B = new Date(b);
    if (isNaN(A.getTime()) || isNaN(B.getTime())) return 999;
    return Math.abs(Math.round((A.getTime() - B.getTime()) / 86400000));
  };
  const match = (e: any, pool: any[]) => {
    const eAmt = Number(e.amount || 0);
    for (const o of pool) {
      if (daysBetween(e.date || '', o.date || '') > 3) continue;
      const oAmt = Number(o.amount || 0);
      if (eAmt && oAmt && Math.abs(oAmt - eAmt) / Math.max(eAmt, 1) <= 0.01) return o;
    }
    return null;
  };

  const matched: any[] = [], missing: any[] = [];
  for (const e of (extracted.entries || [])) {
    const pool = e.type === 'bill' ? ourBills : e.type === 'payment' ? ourPayments : [...ourBills, ...ourPayments];
    const m = match(e, pool);
    if (m) matched.push({ statement: e, ledgr: m });
    else missing.push(e);
  }
  const stmtRefs = (extracted.entries || []).map((e: any) => ({ date: e.date, amount: Number(e.amount || 0) }));
  const extra: any[] = [];
  for (const o of [...ourBills, ...ourPayments]) {
    const oAmt = Number(o.amount || 0);
    const found = stmtRefs.some((r: any) => r.date === o.date && r.amount && Math.abs(r.amount - oAmt) / Math.max(r.amount, 1) <= 0.01);
    if (!found) extra.push(o);
  }
  return { extracted, matched, missingInLedgr: missing, notOnStatement: extra, partyId, party, supplierId: party === 'supplier' ? partyId : undefined };
}

async function buildAiSnapshot(from: string, to: string) {
  const settings = await db.getSettings();
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const service = new V2AppService(runner);
  const context = await service.activeContext();
  if (!context) throw new Error('No active versioned V2 book with an open accounting period');
  const [dashboard, reports, parties, salesAndInvoices, expenseSources, entrySources, inventoryCounts, members, quotes, deliveryNotes] = await Promise.all([
    getV2Dashboard(runner, context.bookId),
    buildPersistentV2Reports(runner, { bookId: context.bookId, from, to }),
    service.listParties(),
    service.listSalesAndInvoices(),
    runner.all<any>("SELECT date,metadata FROM v2_sources WHERE book_id=? AND type='expense' AND date>=? AND date<=? ORDER BY date DESC", [context.bookId, from, to]),
    runner.all<any>(
      `SELECT s.id,s.type,s.date,s.reference,s.metadata,p.name AS party_name
       FROM v2_sources s
       LEFT JOIN v2_parties p ON p.id=json_extract(s.metadata,'$.partyId')
       WHERE s.book_id=?
       ORDER BY s.date DESC,s.id DESC
       LIMIT 300`,
      [context.bookId],
    ),
    runner.all<any>("SELECT id,date,value FROM v2_inventory_counts WHERE book_id=? AND period_id=? ORDER BY date DESC,id DESC", [context.bookId, context.periodId]),
    runner.all<any>("SELECT id,name FROM v2_members WHERE book_id=? ORDER BY name", [context.bookId]),
    db.listQuotes().catch(() => []),
    db.listDeliveryNotes().catch(() => []),
  ]);
  const expensesByCategory: Record<string, number> = {};
  for (const row of expenseSources) {
    let meta: any = {}; try { meta = JSON.parse(row.metadata || '{}'); } catch { continue; }
    if (!meta.reversed && !meta.deleted) expensesByCategory.General = (expensesByCategory.General || 0) + Number(meta.total || 0);
  }
  const recentEntries: any[] = entrySources.flatMap((row: any) => {
    let meta: any = {};
    try { meta = JSON.parse(row.metadata || '{}'); } catch { return []; }
    if (meta.reversed || meta.deleted) return [];
    const entity = row.type === 'cash_purchase' || row.type === 'credit_purchase' ? 'bill'
      : row.type === 'cash_sale' ? 'sale'
      : row.type === 'capital_injection' ? 'capital'
      : row.type === 'credit_note' || row.type === 'debit_note' ? 'note'
      : row.type === 'manual_cash_income' || row.type === 'manual_cash_expense' ? 'cash_entry'
      : row.type;
    return [{
      id: row.id,
      entity,
      sourceType: row.type,
      date: row.date,
      reference: row.reference || '',
      amount: Number(meta.total ?? meta.amount ?? meta.value ?? 0),
      partyId: meta.partyId || '',
      memberId: meta.memberId || '',
      partyName: row.party_name || meta.clientName || meta.supplierName || meta.partnerName || meta.memberName || '',
      category: meta.category || '',
      paymentType: meta.paymentType || '',
      method: meta.method || '',
      notes: meta.notes || '',
      lines: Array.isArray(meta.lines) ? meta.lines.slice(0, 20) : undefined,
    }];
  });
  recentEntries.push(
    ...inventoryCounts.map((row: any) => ({ id: row.id, entity: 'inventory_count', sourceType: 'inventory_count', date: row.date, amount: Number(row.value) })),
    ...quotes.slice(0, 100).map((row: any) => ({ id: row.id, entity: 'quote', sourceType: 'quote', date: row.date, reference: row.quoteNumber || '', amount: Number(row.total || 0), partyName: row.clientName || '', status: row.status, notes: row.notes || '', lines: Array.isArray(row.lines) ? row.lines.slice(0, 20) : [] })),
    ...deliveryNotes.slice(0, 100).map((row: any) => ({ id: row.id, entity: 'delivery_note', sourceType: 'delivery_note', date: row.date, reference: row.noteNumber || '', partyName: row.clientName || '', status: row.status, notes: row.notes || '', items: Array.isArray(row.items) ? row.items.slice(0, 20) : [] })),
  );
  recentEntrÛ®÷ÖÚ$z{-®éÜj×25Æ—FR7F÷&vRr“°Ğ¢6öç7B6W'f–6RÒæWrc$6W'f–6R‡'VææW"“°Ğ¢6öç7B'F–W2Òv—B’æÆ—7DFV'F÷'2‚“°Ğ¢6öç7B&÷w2ÒµÓ°Ğ¢f÷"†6öç7B'G’öb'F–W2’°Ğ¢6öç7BFWF–Ã¢ç’Òv—B6W'f–6RævWE'G”FWF–Â‡'G’æ–BÂv7W7FöÖW"rÂ²g&öÒÂFòÒ“°Ğ¢–b‚FWF–Â’6öçF–çVS°Ğ¢&÷w2çW6‚‡°Ğ¢–C¢FWF–Âæ–BÀĞ¢æÖS¢FWF–ÂææÖRÀĞ¢†öæS¢FWF–Âç†öæRÇÂrrÀĞ¢VÖ–Ã¢FWF–ÂæVÖ–ÂÇÂrrÀĞ¢&Ææ6S¢çVÖ&W"†FWF–Âæ&Ææ6RÇÂ’ÀĞ¢F÷FÄ–çfö–6VC¢çVÖ&W"†FWF–ÂçF÷FÄ–çfö–6VBÇÂ’ÀĞ¢F÷FÅ–C¢çVÖ&W"†FWF–ÂçF÷FÅ–BÇÂ’ÀĞ¢Gfæ6T&Ææ6S¢çVÖ&W"†FWF–ÂæGfæ6T&Ææ6RÇÂ’ÀĞ¢Ò“°Ğ¢ĞĞ¢&WGW&â&÷w3°Ğ¢ÒÀĞ Ğ¢òò–çfö–6W0Ğ¢Æ—7D–çfö–6W3¢7–æ2‚’Óâ°Ğ¢6öç7B'VææW"Ò7F—fU7Å'VææW"‚“²–b‚'VææW"’F‡&÷ræWrW'&÷"‚uc"66÷VçF–ær&WV—&W25Æ—FR7F÷&vRr“°Ğ¢6öç7B6W'f–6RÒæWrc$6W'f–6R‡'VææW"“°Ğ¢6öç7B7FGW6W2ÒæWrÖ‚†v—B6W'f–6RæÆ—7E6ÆW4æD–çfö–6W2‚’’æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rçG—RÓÓÒv–çfö–6Rr’æÖ‚‡&÷s¢ç’’Óâ·&÷ræ–BÂ&÷uÒ’“°Ğ¢&WGW&â†v—Bc%6÷W&6TFö7VÖVçG2…²v–çfö–6RuÒ’’æÖ‚‡&÷s¢ç’’Óâ°Ğ¢6öç7BÆ—fS¢ç’Ò7FGW6W2ævWB‡&÷ræ–B“°Ğ¢&WGW&â²ââç&÷rÂ–çfö–6TçVÖ&W#¢&÷rç&VfW&Væ6RÇÂ&÷ræ–BÂ7FGW3¢Æ—fSòç7FGW2ÇÂ&÷rç7FGW2ÇÂwVç–BrÂ÷VäÖ÷VçC¢Æ—fSòæ÷VäÖ÷VçBóò&÷rçF÷FÂÂÆ–æW3¢'&’æ—4'&’‡&÷ræÆ–æW2’ò&÷ræÆ–æW2¢µÒÓ°Ğ¢Ò“°Ğ¢ÒÀĞ¢7&VFT–çfö–6S¢†–çc¢ç’’Óâ7&VFUG&ç67F–öâ‚v7&VFT–çfö–6RrÂ–çb’ÀĞ¢WFFT–çfö–6S¢†–C¢7G&–ærÂ–çc¢ç’’Óâ×WFFUG&ç67F–öâ‚wWFFT–çfö–6RrÂ–BÂ–çb’ÀĞ¢FVÆWFT–çfö–6S¢†–C¢7G&–ær’Óâ×WFFUG&ç67F–öâ‚vFVÆWFT–çfö–6RrÂ–B’ÀĞ¢Ö&´–çfö–6U–C¢†–C¢7G&–ærÂ–çWCó¢ç’’Óâ×WFFUG&ç67F–öâ‚vÖ&´–çfö–6U–BrÂ–BÂ²âââ†–çWBÇÂ·Ò’ÂFFS¢–çWCòæFFRÇÂÆö6ÅFöF”—6ò‚’ÂÖWF†öC¢–çWCòæÖWF†öBÇÂv66‚rÒ’À¢÷fW&GVT–çfö–6W3¢7–æ2‚’Óâ†v—B’æÆ—7D–çfö–6W2‚’’æf–ÇFW"‚†–çfö–6S¢ç’’Óâ–çfö–6Rç7FGW2ÓÒw–Brbb–çfö–6RæGVTFFRbb–çfö–6RæGVTFFRÂÆö6ÅFöF”—6ò‚’’ÀĞ Ğ¢òò&V6V—G2†ÖöæW’7GVÆÇ’&V6V—fVBĞ¢Æ—7E&V6V—G3¢7–æ2‚’Óâ°Ğ¢6öç7B'VææW"Ò7F—fU7Å'VææW"‚“²–b‚'VææW"’F‡&÷ræWrW'&÷"‚uc"66÷VçF–ær&WV—&W25Æ—FR7F÷&vRr“°Ğ¢6öç7B&V6V—G2Òv—Bc%6÷W&6TFö7VÖVçG2…²w&V6V—BuÒ“°Ğ¢6öç7B–G2Ò&V6V—G2æÖ‚‡&÷s¢ç’’Óâ&÷ræ–B“°Ğ¢6öç7BÆÆö6F–öç2Ò–G2æÆVæwF‚òv—B'VææW"æÆÃÆç“â†4TÄT5B&V6V—E÷6÷W&6Uö–BÆ–çfö–6U÷6÷W&6Uö–BÆÖ÷VçBe$ôÒc%ö–çfö–6UöÆÆö6F–öç2t„U$R&V6V—E÷6÷W&6Uö–B”â‚G¶–G2æÖ‚‚’Óâsòr’æ¦ö–â‚rÂr—Ò–Â–G2’¢µÓ°Ğ¢&WGW&â&V6V—G2æÖ‚‡&÷s¢ç’’Óâ‡²ââç&÷rÂ&V6V—DçVÖ&W#¢&÷rç&VfW&Væ6RÇÂ&÷ræ–BÂFV'F÷$–C¢&÷rç'G”–BÂÖöFS¢&÷ræÖöFRÇÂ„çVÖ&W"‡&÷ræGfæ6R’âòvGfæ6Rr¢vv–ç7Eö–çfö–6Rr’ÂÆÆö6F–öç3¢ÆÆö6F–öç2æf–ÇFW"‚†—FVÓ¢ç’’Óâ—FVÒç&V6V—E÷6÷W&6Uö–BÓÓÒ&÷ræ–B’æÖ‚†—FVÓ¢ç’’Óâ‡²–çfö–6T–C¢—FVÒæ–çfö–6U÷6÷W&6Uö–BÂ–çfö–6U6÷W&6T–C¢—FVÒæ–çfö–6U÷6÷W&6Uö–BÂÖ÷VçDÆ–VC¢çVÖ&W"†—FVÒæÖ÷VçB’ÂÖ÷VçC¢çVÖ&W"†—FVÒæÖ÷VçB’Ò’’Ò’“°Ğ¢ÒÀĞ¢7&VFU&V6V—C¢‡#¢ç’’Óâ7&VFUG&ç67F–öâ‚v7&VFU&V6V—BrÂ"’ÀĞ¢WFFU&V6V—C¢†–C¢7G&–ærÂ–çWC¢ç’’Óâ×WFFUG&ç67F–öâ‚wWFFU&V6V—BrÂ–BÂ–çWB’ÀĞ¢FVÆWFU&V6V—C¢†–C¢7G&–ær’Óâ×WFFUG&ç67F–öâ‚vFVÆWFU&V6V—BrÂ–B’ÀĞ¢–çfö–6U–DÖ÷VçC¢7–æ2†–çfö–6T–C¢7G&–ær’Óâ°Ğ¢6öç7B'VææW"Ò7F—fU7Å'VææW"‚“²–b‚'VææW"’F‡&÷ræWrW'&÷"‚uc"66÷VçF–ær&WV—&W25Æ—FR7F÷&vRr“°Ğ¢6öç7B&÷rÒv—B'VææW"æf—'7CÇ²F÷FÃ¢çVÖ&W"Óâ‚u4TÄT5B4ôÄU44R…5TÒ†Ö÷VçB’Ã’F÷FÂe$ôÒc%ö–çfö–6UöÆÆö6F–öç2t„U$R–çfö–6U÷6÷W&6Uö–CÓòrÂ¶–çfö–6T–EÒ“°Ğ¢&WGW&âçVÖ&W"‡&÷sòçF÷FÂÇÂ“°Ğ¢ÒÀĞ Ğ¢òòV÷FW2òW7F–ÖFW2†æöâ×÷7F–ærVçF–Â6öçfW'FVBĞ¢Æ—7EV÷FW3¢‚’ÓâF"æÆ—7EV÷FW2‚’ÀĞ¢7&VFUV÷FS¢7–æ2‡¢ç’’Óâ²6öç7B"Òv—BF"æ7&VFUV÷FR‡“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀĞ¢WFFUV÷FS¢7–æ2†–C¢7G&–ærÂ¢ç’’Óâ²6öç7B"Òv—BF"çWFFUV÷FR†–BÂ“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀĞ¢FVÆWFUV÷FS¢7–æ2†–C¢7G&–ær’Óâ²6öç7B"Òv—BF"æFVÆWFUV÷FR†–B“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀĞ¢6WEV÷FU7FGW3¢7–æ2†–C¢7G&–ærÂ7FGW3¢ç’’Óâ²6öç7B"Òv—BF"ç6WEV÷FU7FGW2†–BÂ7FGW2“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀĞ¢6öçfW'EV÷FUFô–çfö–6S¢7–æ2†–C¢7G&–ærÂ÷G3ó¢ç’’Óâ°Ğ¢òò´f–æF–ær%Ò&÷WFRF†R–çfö–6R7&VF–öâF‡&÷Vv‚F†R4ÔRc"w&—FRF‚F†PĞ¢òò–çfö–6W267&VVâW6W26òF†R6öçfW'FVB–çfö–6R—2f—6–&ÆRFòF†Rc"ÆVFvW Ğ¢òò†F6†&ö&BÂ&W÷'G2Â'G’FWF–Â’(	Bæ÷B7G&æFVB÷WG6–FRF†RÆVFvW"àĞ¢6öç7B"Òv—BF"æ6öçfW'EV÷FUFô–çfö–6R†–BÂ÷G2Â‡–ÆöC¢ç’’Óâ7&VFUG&ç67F–öâ‚v7&VFT–çfö–6RrÂ–ÆöB’“°Ğ¢'V×FFfW'6–öâ‚“°Ğ¢&WGW&â#°Ğ¢ÒÀĞ Ğ¢òò7&VF—BòFV&—Bæ÷FW2‡÷7B×6ÆRF§W7FÖVçG3¢F—66÷VçG2Â&WGW&ç2ÂW‡G&6†&vW2Ğ¢7&VFT7&VF—Dæ÷FS¢7–æ2†ã¢ç’’Óâ7&VFTæ÷FR‚v7&VFT7&VF—Dæ÷FRrÂâ’ÀĞ¢7&VFTFV&—Dæ÷FS¢7–æ2†ã¢ç’’Óâ7&VFTæ÷FR‚v7&VFTFV&—Dæ÷FRrÂâ’ÀĞ¢WFFTæ÷FS¢7–æ2†–C¢7G&–ærÂã¢ç’’Óâ×WFFUG&ç67F–öâ‚wWFFTæ÷FRrÂ–BÂâ’ÀĞ¢FVÆWFTæ÷FS¢7–æ2†–C¢7G&–ær’Óâ×WFFUG&ç67F–öâ‚vFVÆWFTæ÷FRrÂ–B’ÀĞ Ğ¢òòFVÆ—fW'’æ÷FW2ò6†ÆÆç2†vööG2Ö÷fVÖVçBÂæòÆVFvW"÷7F–ærĞ¢Æ—7DFVÆ—fW'”æ÷FW3¢‚’ÓâF"æÆ—7DFVÆ—fW'”æ÷FW2‚’ÀĞ¢7&VFTFVÆ—fW'”æ÷FS¢7–æ2†ã¢ç’’Óâ²6öç7B"Òv—BF"æ7&VFTFVÆ—fW'”æ÷FR†â“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀĞ¢WFFTFVÆ—fW'”æ÷FS¢7–æ2†–C¢7G&–ærÂã¢ç’’Óâ²6öç7B"Òv—BF"çWFFTFVÆ—fW'”æ÷FR†–BÂâ“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀĞ¢FVÆWFTFVÆ—fW'”æ÷FS¢7–æ2†–C¢7G&–ær’Óâ²6öç7B"Òv—BF"æFVÆWFTFVÆ—fW'”æ÷FR†–B“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀĞ Ğ¢òòVæ†æ6VB&W÷'G0Ğ¢F…&W÷'C¢7–æ2†g&öÓ¢7G&–ærÂFó¢7G&–ær’Óâ°Ğ¢6öç7B·6WGF–æw2Â6öæf–rÂ–çfö–6W2Â66…6ÆW2Â&–ÆÇ2Â7&VF—Dæ÷FW2ÂFV&—Dæ÷FW2ÂÆ—fU&V6V—G2Â&W÷'EÒÒv—B&öÖ—6RæÆÂ…°Ğ¢’ævWE6WGF–æw2‚’Â’ævWEc$&öö´6öæf–r‚’Âc%6÷W&6TFö7VÖVçG2…²v–çfö–6RuÒ’Âc%6÷W&6TFö7VÖVçG2…²v66…÷6ÆRuÒ’Âc%6÷W&6TFö7VÖVçG2…²v66…÷W&6†6RrÂv7&VF—E÷W&6†6RuÒ’Âc%6÷W&6TFö7VÖVçG2…²v7&VF—Eöæ÷FRuÒ’Âc%6÷W&6TFö7VÖVçG2…²vFV&—Eöæ÷FRuÒ’Â’æÆ—7E&V6V—G2‚’Âc%&W÷'B†g&öÒÂFò’æ6F6‚‚‚’ÓâçVÆÂ’ÀĞ¢Ò“°Ğ¢6öç7B–å&ævRÒ‡&÷s¢ç’’Óâ&÷ræFFRãÒg&öÒbb&÷ræFFRÃÒFó°Ğ¢6öç7BF„öbÒ†w&÷73¢çVÖ&W"Â&FS¢çVÖ&W"’Óâ&FRâòÖF‚ç&÷VæB‚†w&÷72Òw&÷72òƒ²&FRò’’¢’ò¢°Ğ¢6öç7B&÷uF„Ö÷VçBÒ‡&÷s¢ç’’Óâ°Ğ¢6öç7BF÷FÂÒçVÖ&W"‡&÷rçF÷FÂÇÂ&÷ræÖ÷VçBÇÂ“°Ğ¢&WGW&âçVÖ&W"‡&÷rçF‚óò&÷ræÖWFFFòçF‚óò‡&÷rçF…&FRòF„öb‡F÷FÂÂçVÖ&W"‡&÷rçF…&FR’’¢’“°Ğ¢Ó°Ğ¢6öç7B&6—2Ò6öæf–sòæ&6—2ÓÓÒv66‚ròv66‚r¢v67'VÂs°Ğ¢6öç7B&FRÒçVÖ&W"‡6WGF–æw2çF…&FRÇÂ“°Ğ Ğ¢ÆWB÷WGWD&6RÒ°Ğ¢ÆWB÷WGWEF‚Ò°Ğ¢–b†&6—2ÓÓÒv67'VÂr’°Ğ¢6öç7B6ÆW5&÷w2Ò²ââæ–çfö–6W2Âââæ66…6ÆW5Òæf–ÇFW"†–å&ævR“°Ğ¢f÷"†6öç7B&÷röb6ÆW5&÷w2’°Ğ¢6öç7BF÷FÂÒçVÖ&W"‡&÷rçF÷FÂÇÂ&÷ræÖ÷VçBÇÂ“°Ğ¢6öç7B&÷uF‚Ò&÷uF„Ö÷VçB‡&÷r“°Ğ¢6öç7B&6RÒçVÖ&W"‡&÷rç7V'F÷FÂóò&÷ræÖWFFFòç7V'F÷FÂóò‡F÷FÂÒ&÷uF‚’“°Ğ¢÷WGWD&6R³Ò&6S°Ğ¢÷WGWEF‚³Ò&÷uFƒ°Ğ¢ĞĞ¢ÒVÇ6R°Ğ¢f÷"†6öç7B&÷röb66…6ÆW2æf–ÇFW"†–å&ævR’’°Ğ¢6öç7BF÷FÂÒçVÖ&W"‡&÷rçF÷FÂÇÂ&÷ræÖ÷VçBÇÂ“°Ğ¢6öç7B&÷uF‚Ò&÷uF„Ö÷VçB‡&÷r“°Ğ¢÷WGWEF‚³Ò&÷uFƒ°Ğ¢÷WGWD&6R³ÒçVÖ&W"‡&÷rç7V'F÷FÂóò&÷ræÖWFFFòç7V'F÷FÂóò‡F÷FÂÒ&÷uF‚’“°Ğ¢ĞĞ¢6öç7B–çfö–6T'”–BÒæWrÖ†–çfö–6W2æÖ‚‡&÷s¢ç’’Óâ·&÷ræ–BÂ&÷uÒ’“°Ğ¢f÷"†6öç7B&V2öb†Æ—fU&V6V—G22ç•µÒ’æf–ÇFW"†–å&ævR’’°Ğ¢6öç7BÆÆö72Ò'&’æ—4'&’‡&V2æÆÆö6F–öç2’ò&V2æÆÆö6F–öç2¢µÓ°Ğ¢6öç7B&V5F÷FÂÒçVÖ&W"‡&V2çF÷FÂÇÂ&V2æÖ÷VçBÇÂ“°Ğ¢ÆWBÆÆö6FVBÒ°Ğ¢–b†ÆÆö72æÆVæwF‚’°Ğ¢f÷"†6öç7BÆÆö2öbÆÆö72’°Ğ¢6öç7B–çbÒ–çfö–6T'”–BævWB†ÆÆö2æ–çfö–6T–BÇÂÆÆö2æ–çfö–6U6÷W&6T–B“°Ğ¢6öç7BF¶RÒçVÖ&W"†ÆÆö2æÖ÷VçDÆ–VBóòÆÆö2æÖ÷VçBóò“°Ğ¢ÆÆö6FVB³ÒF¶S°Ğ¢6öç7B–çeF÷FÂÒçVÖ&W"†–çcòçF÷FÂÇÂ–çcòæÖ÷VçBÇÂ“°Ğ¢6öç7B–çeF‚Ò–çbò&÷uF„Ö÷VçB†–çb’¢°Ğ¢–b†–çbbb–çeF÷FÂâbb–çeF‚’°Ğ¢6öç7B6†&RÒF¶Rò–çeF÷FÃ°Ğ¢÷WGWEF‚³Ò–çeF‚¢6†&S°Ğ¢÷WGWD&6R³Ò†–çeF÷FÂÒ–çeF‚’¢6†&S°Ğ¢ÒVÇ6R°Ğ¢÷WGWD&6R³ÒF¶S°Ğ¢ĞĞ¢ĞĞ¢ĞĞ¢6öç7B&VÖ–æFW"ÒÖF‚ç&÷VæB‚‡&V5F÷FÂÒÆÆö6FVB’¢’ò°Ğ¢–b‚ÆÆö72æÆVæwF‚’°Ğ¢6öç7B&÷uF‚Ò&÷uF„Ö÷VçB‡&V2“°Ğ¢÷WGWEF‚³Ò&÷uFƒ°Ğ¢÷WGWD&6R³Ò&V5F÷FÂÒ&÷uFƒ°Ğ¢ÒVÇ6R–b‡&VÖ–æFW"âãR’°Ğ¢òòVæÆÆö6FVB&VÖ–æFW"—2âGfæ6S¢F‚öæÇ’–bF†R&V6V—B—G6VÆb6'&–W2F‚àĞ¢6öç7B&V5F‚Ò&÷uF„Ö÷VçB‡&V2“°Ğ¢6öç7B&VÕF‚Ò&V5F÷FÂâbb&V5F‚ò&V5F‚¢‡&VÖ–æFW"ò&V5F÷FÂ’¢°Ğ¢÷WGWEF‚³Ò&VÕFƒ°Ğ¢÷WGWD&6R³Ò&VÖ–æFW"Ò&VÕFƒ°Ğ¢ĞĞ¢ĞĞ¢ĞĞ Ğ¢6öç7B7W7FöÖW$7&VF—Dæ÷FW2Ò7&VF—Dæ÷FW2æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rç&öÆRÓÒw7WÆ–W"r“°Ğ¢6öç7B7W7FöÖW$FV&—Dæ÷FW2ÒFV&—Dæ÷FW2æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rç&öÆRÓÒw7WÆ–W"r“°Ğ¢6öç7B7WÆ–W$7&VF—Dæ÷FW2Ò7&VF—Dæ÷FW2æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rç&öÆRÓÓÒw7WÆ–W"r“°Ğ¢6öç7B7WÆ–W$FV&—Dæ÷FW2ÒFV&—Dæ÷FW2æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rç&öÆRÓÓÒw7WÆ–W"r“°Ğ¢6öç7Bæ÷FUF‚Ò‡&÷w3¢ç•µÒ’Óâ&÷w2æf–ÇFW"†–å&ævR’ç&VGV6R‚‡7VÓ¢çVÖ&W"Â&÷s¢ç’’Óâ7VÒ²&÷uF„Ö÷VçB‡&÷r’Â“°Ğ¢6öç7B7&VF—Dæ÷FUF‚Òæ÷FUF‚†7W7FöÖW$7&VF—Dæ÷FW2“°Ğ¢6öç7BFV&—Dæ÷FUF‚Òæ÷FUF‚†7W7FöÖW$FV&—Dæ÷FW2“°Ğ¢6öç7B7WÆ–W$7&VF—Dæ÷FUF‚Òæ÷FUF‚‡7WÆ–W$7&VF—Dæ÷FW2“°Ğ¢6öç7B7WÆ–W$FV&—Dæ÷FUF‚Òæ÷FUF‚‡7WÆ–W$FV&—Dæ÷FW2“°Ğ¢6öç7BæWD÷WGWEF‚ÒÖF‚ç&÷VæB‚†÷WGWEF‚Ò7&VF—Dæ÷FUF‚²FV&—Dæ÷FUF‚’¢’ò°Ğ Ğ¢ÆWB–çWD&6RÒ°Ğ¢ÆWB–çWEF‚Ò°Ğ¢–b†&6—2ÓÓÒv67'VÂr’°Ğ¢f÷"†6öç7B&÷röb&–ÆÇ2æf–ÇFW"†–å&ævR’’°Ğ¢6öç7BF÷FÂÒçVÖ&W"‡&÷ræÖ÷VçBÇÂ&÷rçF÷FÂÇÂ“°Ğ¢6öç7B&÷uF‚Ò&÷uF„Ö÷VçB‡&÷r“°Ğ¢–çWD&6R³ÒçVÖ&W"‡&÷rç7V'F÷FÂóò&÷ræÖWFFFòç7V'F÷FÂóò‡F÷FÂÒ&÷uF‚’“°Ğ¢–çWEF‚³Ò&÷uFƒ°Ğ¢ĞĞ¢ÒVÇ6R°Ğ¢f÷"†6öç7B&÷röb&–ÆÇ2æf–ÇFW"†–å&ævR’æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rçG—RÓÓÒv66…÷W&6†6Rr’’°Ğ¢6öç7BF÷FÂÒçVÖ&W"‡&÷ræÖ÷VçBÇÂ&÷rçF÷FÂÇÂ“°Ğ¢6öç7B&÷uF‚Ò&÷uF„Ö÷VçB‡&÷r“°Ğ¢–çWD&6R³ÒçVÖ&W"‡&÷rç7V'F÷FÂóò&÷ræÖWFFFòç7V'F÷FÂóò‡F÷FÂÒ&÷uF‚’“°Ğ¢–çWEF‚³Ò&÷uFƒ°Ğ¢ĞĞ¢6öç7B–ÖVçG2Ò†v—Bc%6÷W&6TFö7VÖVçG2…²w7WÆ–W%÷–ÖVçBuÒ’’æf–ÇFW"†–å&ævR“°Ğ¢6öç7B7&VF—D&–ÆÇ2Ò&–ÆÇ2æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rçG—RÓÓÒv7&VF—E÷W&6†6Rr“°Ğ¢f÷"†6öç7B’öb–ÖVçG2’°Ğ¢6öç7B6WGFÆVBÒÖF‚æÖ‚ƒÂçVÖ&W"‡’çF÷FÂÇÂ’æÖ÷VçBÇÂ’ÒçVÖ&W"‡’æÖWFFFòç7WÆ–W$Gfæ6RÇÂ’“°Ğ¢–b‡6WGFÆVBÃÒãR’6öçF–çVS°Ğ¢6öç7B'G”&–ÆÇ2Ò7&VF—D&–ÆÇ2æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rç'G”–Bbb&÷rç'G”–BÓÓÒ’ç'G”–B“°Ğ¢6öç7B&–ÆÅF÷FÂÒ'G”&–ÆÇ2ç&VGV6R‚‡7VÓ¢çVÖ&W"Â&÷s¢ç’’Óâ7VÒ²çVÖ&W"‡&÷rçF÷FÂÇÂ&÷ræÖ÷VçBÇÂ’Â“°Ğ¢6öç7B&–ÆÅF‚Ò'G”&–ÆÇ2ç&VGV6R‚‡7VÓ¢çVÖ&W"Â&÷s¢ç’’Óâ7VÒ²&÷uF„Ö÷VçB‡&÷r’Â“°Ğ¢–b†&–ÆÅF÷FÂâbb&–ÆÅF‚’°Ğ¢6öç7B6†&RÒÖF‚æÖ–âƒÂ6WGFÆVBò&–ÆÅF÷FÂ“°Ğ¢–çWEF‚³Ò&–ÆÅF‚¢6†&S°Ğ¢–çWD&6R³Ò†&–ÆÅF÷FÂÒ&–ÆÅF‚’¢6†&S°Ğ¢ĞĞ¢ĞĞ¢ĞĞ¢6öç7Bæ÷FT&6RÒ‡&÷w3¢ç•µÒ’Óâ&÷w2æf–ÇFW"†–å&ævR’ç&VGV6R‚‡7VÓ¢çVÖ&W"Â&÷s¢ç’’Óâ°Ğ¢6öç7BF÷FÂÒçVÖ&W"‡&÷rçF÷FÂÇÂ&÷ræÖ÷VçBÇÂ“°Ğ¢&WGW&â7VÒ²F÷FÂÒ&÷uF„Ö÷VçB‡&÷r“°Ğ¢ÒÂ“°Ğ¢6öç7B7WÆ–W$7&VF—Dæ÷FT&6RÒæ÷FT&6R‡7WÆ–W$7&VF—Dæ÷FW2“°Ğ¢6öç7B7WÆ–W$FV&—Dæ÷FT&6RÒæ÷FT&6R‡7WÆ–W$FV&—Dæ÷FW2“°Ğ¢–çWD&6RÒ–çWD&6RÒ7WÆ–W$7&VF—Dæ÷FT&6R²7WÆ–W$FV&—Dæ÷FT&6S°Ğ¢–çWEF‚Ò–çWEF‚Ò7WÆ–W$7&VF—Dæ÷FUF‚²7WÆ–W$FV&—Dæ÷FUFƒ°Ğ¢–çWD&6RÒÖF‚ç&÷VæB†–çWD&6R¢’ò°Ğ¢–çWEF‚ÒÖF‚ç&÷VæB†–çWEF‚¢’ò°Ğ¢÷WGWD&6RÒÖF‚ç&÷VæB†÷WGWD&6R¢’ò°Ğ¢÷WGWEF‚ÒÖF‚ç&÷VæB†÷WGWEF‚¢’ò°Ğ Ğ¢6öç7BvÅF…–&ÆRÒÖF‚ç&÷VæB‚‡&W÷'CòæFWF–Ç2ÇÂµÒĞ¢æf–ÇFW"‚†Æ–æS¢ç’’ÓâÆ–æRæ66÷VçD6öFRÓÓÒs#3rĞ¢ç&VGV6R‚‡7VÓ¢çVÖ&W"ÂÆ–æS¢ç’’Óâ7VÒ²çVÖ&W"†Æ–æRæ7&VF—BÇÂ’ÒçVÖ&W"†Æ–æRæFV&—BÇÂ’Â’¢’ò°Ğ¢6öç7BæWEF…–&ÆRÒÖF‚ç&÷VæB‚†æWD÷WGWEF‚Ò–çWEF‚’¢’ò°Ğ¢6öç7BF…&V6öæ6–Æ–F–öäF–ffW&Væ6RÒÖF‚ç&÷VæB‚†æWEF…–&ÆRÒvÅF…–&ÆR’¢’ò°Ğ¢6öç7BF…&V6öæ6–ÆVBÒÖF‚æ'2‡F…&V6öæ6–Æ–F–öäF–ffW&Væ6R’ÃÒãS°Ğ Ğ¢&WGW&â°Ğ¢g&öÒÂFòÂF„Æ&VÃ¢6WGF–æw2çF„Æ&VÂÇÂuF‚rÂF…&FS¢&FRÂ&6—2ÀĞ¢÷WGWD&6RÂ÷WGWEF‚Â7&VF—Dæ÷FUF‚ÂFV&—Dæ÷FUF‚ÂæWD÷WGWEF‚ÀĞ¢–çWD&6RÂ–çWEF‚Â7WÆ–W$7&VF—Dæ÷FUF‚Â7WÆ–W$FV&—Dæ÷FUF‚ÂæWEF…–&ÆRÂvÅF…–&ÆRÀĞ¢F…&V6öæ6–Æ–F–öäF–ffW&Væ6RÂF…&V6öæ6–ÆVBÂvÅ&V6öæ6–Æ–F–öäÆ–6&ÆS¢&6—2ÓÓÒv67'VÂrÀĞ¢66„&6—5öÆ–7“¢&6—2ÓÓÒv66‚pĞ¢òt–çWBF‚—2&V6övæ—¦VBv†Vâ66‚—2–BâGfæ6W2&RF†VBöæÇ’–bF†R&V6V—B—G6VÆb6'&–W2F‚âpĞ¢¢VæFVf–æVBÀĞ¢Ó°Ğ¢ÒÀĞ¢6ÆW5&Vv—7FW#¢7–æ2†g&öÓ¢7G&–ærÂFó¢7G&–ærÂÆö6F–öä–Có¢7G&–ær’Óâ°Ğ¢6öç7B–äÆö6F–öâÒ‡&÷s¢ç’’ÓâÆö6F–öä–BÇÂ7G&–ær‡&÷ræÆö6F–öä–BÇÂ&÷ræÖWFFFòæÆö6F–öä–BÇÂrr’ÓÓÒÆö6F–öä–C°Ğ¢6öç7B&÷w2Ò†v—Bc%6÷W&6TFö7VÖVçG2…²v66…÷6ÆRrÂv–çfö–6RuÒ’’æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷ræFFRãÒg&öÒbb&÷ræFFRÃÒFòbb–äÆö6F–öâ‡&÷r’’æÖ‚‡&÷s¢ç’’Óâ‡²FFS¢&÷ræFFRÂG—S¢&÷rçG—RÓÓÒv–çfö–6Rròt–çfö–6Rr¢t66‚6ÆRrÂ&Vc¢&÷rç&VfW&Væ6RÇÂrrÂ'G“¢&÷rç'G”æÖRÇÂrrÂÖ÷VçC¢&÷ræÖ÷VçBÂ7FGW3¢&÷rç7FGW2Ò’“°Ğ¢6öç7B66…F÷FÂÒ&÷w2æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rçG—RÓÓÒt66‚6ÆRr’ç&VGV6R‚‡7VÓ¢çVÖ&W"Â&÷s¢ç’’Óâ7VÒ²&÷ræÖ÷VçBÂ“°Ğ¢6öç7B–çfö–6UF÷FÂÒ&÷w2æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rçG—RÓÓÒt–çfö–6Rr’ç&VGV6R‚‡7VÓ¢çVÖ&W"Â&÷s¢ç’’Óâ7VÒ²&÷ræÖ÷VçBÂ“°Ğ¢&WGW&â²g&öÒÂFòÂ&÷w3¢&÷w2ç6÷'B‚†¢ç’Æ#¢ç’’ÓâæFFRæÆö6ÆT6ö×&R†"æFFR’’ÂF÷FÃ¢66…F÷FÂ²–çfö–6UF÷FÂÂ66…F÷FÂÂ–çfö–6UF÷FÂÂ6÷VçC¢&÷w2æÆVæwF‚Ó°Ğ¢ÒÀĞ¢&V6V—G5&Vv—7FW#¢7–æ2†g&öÓ¢7G&–ærÂFó¢7G&–ærÂÆö6F–öä–Có¢7G&–ær’Óâ°Ğ¢6öç7B–äÆö6F–öâÒ‡&÷s¢ç’’ÓâÆö6F–öä–BÇÂ7G&–ær‡&÷ræÆö6F–öä–BÇÂ&÷ræÖWFFFòæÆö6F–öä–BÇÂrr’ÓÓÒÆö6F–öä–C°Ğ¢6öç7B&÷w2Ò†v—B’æÆ—7E&V6V—G2‚’’æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷ræFFRãÒg&öÒbb&÷ræFFRÃÒFòbb–äÆö6F–öâ‡&÷r’’æÖ‚‡&÷s¢ç’’Óâ‡²FFS¢&÷ræFFRÂ&Vc¢&÷rç&V6V—DçVÖ&W"Â'G“¢&÷ræ6Æ–VçDæÖRÇÂuvÆ²Ö–ârÂÖöFS¢&÷ræÖöFRÂÖWF†öC¢&÷ræÖWF†öBÇÂv66‚rÂÖ÷VçC¢&÷ræÖ÷VçBÒ’“°Ğ¢6öç7B'”ÖWF†öC¢&V6÷&CÇ7G&–ærÂçVÖ&W#âÒ·Ó²6öç7B'”ÖöFS¢&V6÷&CÇ7G&–ærÂçVÖ&W#âÒ·Ó°Ğ¢f÷"†6öç7B&÷röb&÷w2’²'”ÖWF†öE·&÷ræÖWF†öEÒÒ†'”ÖWF†öE·&÷ræÖWF†öEÒÇÂ’²&÷ræÖ÷VçC²'”ÖöFU·&÷ræÖöFUÒÒ†'”ÖöFU·&÷ræÖöFUÒÇÂ’²&÷ræÖ÷VçC²ĞĞ¢&WGW&â²g&öÒÂFòÂ&÷w3¢&÷w2ç6÷'B‚†¢ç’Æ#¢ç’’ÓâæFFRæÆö6ÆT6ö×&R†"æFFR’’Â'”ÖWF†öBÂ'”ÖöFRÂF÷FÃ¢&÷w2ç&VGV6R‚‡7VÓ¢çVÖ&W"Â&÷s¢ç’’Óâ7VÒ²&÷ræÖ÷VçBÂ’Â6÷VçC¢&÷w2æÆVæwF‚Ó°Ğ¢ÒÀĞ§Ó°Ğ