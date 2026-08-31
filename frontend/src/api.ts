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
import type { PersonaId } from '@/src/accountingV2/config';
import { getEnabledFeatures, type FeatureKey } from '@/src/utils/featureFlags';
import { assertFeatureDisableAllowed } from '@/src/accountingV2/featureDisableGuards';
import { readV2BookPrefs, writeV2BookPrefs } from '@/src/accountingV2/optionalModules';
import { getV2Dashboard } from '@/src/accountingV2/v2Dashboard';
import { partnershipDisplayFromReports } from './accountingV2/reports';
import { buildPersistentV2Reports } from '@/src/accountingV2/persistentReports';
import { resetAllV2AccountingData, factoryResetV2Data } from '@/src/accountingV2/resetBook';
import { V2InvestorLedgerService, type InvestorLedgerDetail } from '@/src/accountingV2/investorLedgerService';
import { selfHostedSync } from '@/src/accountingV2/services/selfHostedSyncService';
import { V2SqlRepository } from '@/src/accountingV2/repository';
import { resolveWriteLocationId } from '@/src/accountingV2/services/locationDomainService';
import { V2DocumentService } from '@/src/accountingV2/documentService';
import { v2Services } from '@/src/accountingV2/runtime';
import { configureSync, disableSync, enableSync, getSyncStatus, markSyncRecoveryRequired, retrySyncNow, syncNow, withSyncedMutation, type SyncMutation } from '@/src/sync/coordinator';
import { listOpenSyncConflicts, listSyncCorrectionAccounts, resolveSyncConflict as resolveSyncConflictDecision, type ConflictResolutionType } from '@/src/sync/conflicts';
import { createSyncEnrollmentCode, enrollSyncDevice, installServerSnapshot, listSyncDevices, listSyncMemberships, publishServerSnapshot, redeemSyncEnrollmentCode, removeSyncMembership, renameSyncDevice, revokeSyncDevice, setSyncMembershipLocations, upsertSyncMembership, verifyProjectionCheckpoint } from '@/src/sync/recovery';
import { BOOK_PROJECTION_SCHEMA_VERSION, exportBookProjection, hashBookProjection, installBookProjection } from '@/src/sync/projection';
import type { SyncOperation } from '@/src/sync/protocol';
import { authorizeSyncOidc as runSyncOidcAuthorization } from '@/src/sync/oidc';
import { checkLocalIntegrity } from '@/src/utils/localIntegrity';
import { getRequestedHostingMode, setRequestedHostingMode, type HostingMode } from '@/src/utils/hostingMode';
import { listBackupHistory } from '@/src/utils/backupHistory';
import {
  listBooks as beListBooks,
  activeBookId as beActiveBookId,
  activeSqlRunner,
  setActiveBook as beSetActiveBook,
  createBook as beCreateBook,
  renameBook as beRenameBook,
  deleteBook as beDeleteBook,
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
const LAST_BACKUP_KEY        = 'ledgr:last_backup_at';
// Exported so the reset UI (advanced-settings) can assert/reset in lockstep and
// tests can enumerate the exact device-level keys a factory reset must clear.
export const FACTORY_RESET_PREF_KEYS = [
  THEME_MODE_KEY,
  ANIMATIONS_ENABLED_KEY,
  TILE_ORDER_KEY,
  TILE_USAGE_KEY,
  'ledgr:hosting_mode',
  LAST_BACKUP_KEY,
] as const;

let webSessionAiKey = '';
let webSessionTranscriptionAiKey = '';
const isWebRuntime = typeof window !== 'undefined' && typeof document !== 'undefined';

export async function getAIConfig(): Promise<AIConfig> {
  const [provider, secureKey, storedKey, model, visionModel, transcriptionModel, transcriptionBaseUrl, secureTranscriptionKey, baseUrl] = await Promise.all([
    AsyncStorage.getItem(AI_PROVIDER_KEY),
    isWebRuntime ? Promise.resolve(webSessionAiKey) : storage.secureGet(AI_API_KEY_KEY, ''),
    isWebRuntime ? Promise.resolve(null) : AsyncStorage.getItem(AI_API_KEY_KEY),
    AsyncStorage.getItem(AI_MODEL_KEY),
    AsyncStorage.getItem(AI_VISION_MODEL_KEY),
    AsyncStorage.getItem(AI_TRANSCRIPTION_MODEL_KEY),
    AsyncStorage.getItem(AI_TRANSCRIPTION_BASE_URL_KEY),
    isWebRuntime ? Promise.resolve(webSessionTranscriptionAiKey) : storage.secureGet(AI_TRANSCRIPTION_API_KEY_KEY, ''),
    AsyncStorage.getItem(AI_BASE_URL_KEY),
  ]);
  if (isWebRuntime) await AsyncStorage.removeItem(AI_API_KEY_KEY).catch(() => {});
  const resolvedKey = isWebRuntime ? webSessionAiKey : (secureKey || storedKey || '');
  if (!isWebRuntime && resolvedKey && !secureKey) {
    let migrated = false;
    try { migrated = await storage.secureSet(AI_API_KEY_KEY, resolvedKey); } catch { migrated = false; }
    if (migrated) await AsyncStorage.removeItem(AI_API_KEY_KEY);
    else console.warn('[ai] Secure key migration failed; retaining legacy key for recovery.');
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
  let secureKeyWrite: Promise<boolean> | null = null;
  let transcriptionKeyWrite: Promise<boolean> | null = null;
  if (cfg.apiKey !== undefined) {
    if (isWebRuntime) {
      webSessionAiKey = cfg.apiKey || '';
      secureKeyWrite = AsyncStorage.removeItem(AI_API_KEY_KEY).then(() => true).catch(() => false);
    } else {
      secureKeyWrite = cfg.apiKey ? storage.secureSet(AI_API_KEY_KEY, cfg.apiKey) : storage.secureRemove(AI_API_KEY_KEY);
    }
  }
  if (cfg.transcriptionApiKey !== undefined) {
    if (isWebRuntime) {
      webSessionTranscriptionAiKey = cfg.transcriptionApiKey || '';
      transcriptionKeyWrite = AsyncStorage.removeItem(AI_TRANSCRIPTION_API_KEY_KEY).then(() => true).catch(() => false);
    } else {
      transcriptionKeyWrite = cfg.transcriptionApiKey ? storage.secureSet(AI_TRANSCRIPTION_API_KEY_KEY, cfg.transcriptionApiKey) : storage.secureRemove(AI_TRANSCRIPTION_API_KEY_KEY);
    }
  }
  if (cfg.model !== undefined) ops.push(AsyncStorage.setItem(AI_MODEL_KEY, cfg.model));
  if (cfg.visionModel !== undefined) ops.push(AsyncStorage.setItem(AI_VISION_MODEL_KEY, cfg.visionModel));
  if (cfg.transcriptionModel !== undefined) ops.push(AsyncStorage.setItem(AI_TRANSCRIPTION_MODEL_KEY, cfg.transcriptionModel));
  if (cfg.transcriptionBaseUrl !== undefined) ops.push(AsyncStorage.setItem(AI_TRANSCRIPTION_BASE_URL_KEY, ai.validateAIBaseUrl(cfg.transcriptionBaseUrl)));
  if (cfg.baseUrl !== undefined) ops.push(AsyncStorage.setItem(AI_BASE_URL_KEY, ai.validateAIBaseUrl(cfg.baseUrl)));
  const [secureOk, transcriptionSecureOk] = await Promise.all([
    secureKeyWrite ?? Promise.resolve(true),
    transcriptionKeyWrite ?? Promise.resolve(true),
    ...ops,
  ]);
  if ((secureKeyWrite && secureOk === false) || (transcriptionKeyWrite && transcriptionSecureOk === false)) {
    throw new Error('Could not securely save your AI API key on this device. Please try again.');
  }
  if (secureKeyWrite && cfg.apiKey !== undefined) await AsyncStorage.removeItem(AI_API_KEY_KEY);
  if (transcriptionKeyWrite && cfg.transcriptionApiKey !== undefined) await AsyncStorage.removeItem(AI_TRANSCRIPTION_API_KEY_KEY);
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

type AiDataMode = 'summary' | 'detailed';

async function buildAiSnapshot(from: string, to: string, mode: AiDataMode = 'summary') {
  const runner = activeSqlRunner();
  if (!runner) throw new Error('V2 accounting requires SQLite storage');
  const service = new V2AppService(runner);
  const [settings, context] = await Promise.all([db.getSettings(), service.activeContext()]);
  if (!context) throw new Error('No active versioned V2 book with an open accounting period');

  // Summary mode is the default and only needs the KPI/report totals. Avoid
  // loading full parties, source rows, quotes, delivery notes, and inventory
  // history for every ordinary question.
  const [dashboard, reports] = await Promise.all([
    getV2Dashboard(runner, context.bookId),
    buildPersistentV2Reports(runner, { bookId: context.bookId, from, to }),
  ]);
  const detailed = mode === 'detailed';
  if (!detailed) {
    return {
      source: 'v2', currency: settings.currency, businessName: settings.businessName,
      snapshot: { cash: dashboard.cash, inventoryValue: dashboard.inventoryValue, netWorth: dashboard.netWorth, totalSales: dashboard.totalSales, totalPurchases: dashboard.totalPurchases, grossProfit: dashboard.grossProfit, netProfit: dashboard.netProfit },
      yearToDate: reports.profitAndLoss,
      creditors: [], debtors: [], expensesByCategory: {}, openInvoices: [], parties: [], capitalAccounts: [],
      recentEntries: [], snapshotLimit: 0, snapshotTruncated: false,
    };
  }

  const [parties, salesAndInvoices, expenseSources, entrySources, inventoryCounts, members, quotes, deliveryNotes] = await Promise.all([
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
    db.listDelivßúÚÚ$z{-®éÜj×ærÂÖ–ÖUG—RÒv–ÖvRö§VrrÂ'G“¢w7WÆ–W"rÂv7W7FöÖW"rÒw7WÆ–W"r’Óâ&V6öæ6–ÆU7FFVÖVçB†–ÖvT&6ScBÂ'G”–BÂÖ–ÖUG—RÂ'G’’À¢6´&öö·3¢7–æ2‡VW7F–öã¢7G&–ærÂFF6öçFW‡C¢7G&–ær’Óâ’æ6´&öö·2†v—BvWD”6öæf–r‚’ÂVW7F–öâÂFF6öçFW‡B’À ¢òòW‡Vç6W0¢Æ—7DW‡Vç6W3¢7–æ2‚’Óâ—5vV%'VçF–ÖP¢òF"æÆ—7DW‡Vç6W2‚¢¢†v—Bc%6÷W&6TFö7VÖVçG2…²vW‡Vç6RuÒ’’æÖ‚‡&÷s¢ç’’Óâ‡²ââç&÷rÂ6FVv÷'“¢&÷ræ6FVv÷'’ÇÂtW‡Vç6RrÒ’’À¢7&VFTW‡Vç6S¢†S¢ç’’Óâ—5vV%'VçF–ÖRòF"æ7&VFTW‡Vç6R†R’çF†Vâ‚‡&W7VÇB’Óâ²'V×FFfW'6–öâ‚“²&WGW&â&W7VÇC²Ò’¢7&VFUG&ç67F–öâ‚v7&VFTW‡Vç6RrÂR’À¢WFFTW‡Vç6S¢†–C¢7G&–ærÂS¢ç’’Óâ—5vV%'VçF–ÖRòF"çWFFTW‡Vç6R†–BÂR’çF†Vâ‚‡&W7VÇB’Óâ²'V×FFfW'6–öâ‚“²&WGW&â&W7VÇC²Ò’¢×WFFUG&ç67F–öâ‚wWFFTW‡Vç6RrÂ–BÂR’À¢FVÆWFTW‡Vç6S¢†–C¢7G&–ær’Óâ—5vV%'VçF–ÖRòF"æFVÆWFTW‡Vç6R†–B’çF†Vâ‚‡&W7VÇB’Óâ²'V×FFfW'6–öâ‚“²&WGW&â&W7VÇC²Ò’¢×WFFUG&ç67F–öâ‚vFVÆWFTW‡Vç6RrÂ–B’À ¢òòFV'F÷'0¢Æ—7DFV'F÷'3¢7–æ2†Æö6F–öä–Có¢7G&–ær’Óâ°¢–b†—5vV%'VçF–ÖR’&WGW&âF"æÆ—7DFV'F÷'2‚“°¢6öç7B'F–W2Ò†v—B’æÆ—7E'F–W2†Æö6F–öä–B’’æf–ÇFW"‚‡'G“¢ç’’Óâ'G’ç&öÆW2æ–æ6ÇVFW2‚v7W7FöÖW"r’“°¢6öç7B'VææW"Ò7F—fU7Å'VææW"‚“²–b‚'VææW"’F‡&÷ræWrW'&÷"‚uc"66÷VçF–ær&WV—&W25Æ—FR7F÷&vRr“°¢6öç7B6W'f–6RÒæWrc$6W'f–6R‡'VææW"“°¢&WGW&â&öÖ—6RæÆÂ‡'F–W2æÖ†7–æ2‡'G“¢ç’’Óâ°¢6öç7BFWF–Ã¢ç’Òv—B6W'f–6RævWE'G”FWF–Â‡'G’æ–BÂv7W7FöÖW"rÂÆö6F–öä–B“°¢&WGW&â²ââç'G’ÂââæFWF–ÂÂ&Ææ6S¢FWF–Ãòæ&Ææ6Róò'G’ç&V6V—f&ÆRóòÂ&V6V—f&ÆS¢FWF–Ãòæ&Ææ6Róò'G’ç&V6V—f&ÆRóòÂF÷FÄ–çfö–6VC¢FWF–ÃòçF÷FÄ–çfö–6VBóòÂF÷FÅ–C¢FWF–ÃòçF÷FÅ–BóòÂGfæ6T&Ææ6S¢FWF–ÃòæGfæ6T&Ææ6RóòÓ°¢Ò’“°¢ÒÀ¢vWD7W7FöÖW#¢7–æ2†–C¢7G&–ærÂÆö6F–öä–Có¢7G&–ær’Óâ°¢6öç7B'VææW"Ò7F—fU7Å'VææW"‚“²–b‚'VææW"’F‡&÷ræWrW'&÷"‚uc"66÷VçF–ær&WV—&W25Æ—FR7F÷&vRr“°¢6öç7BFWF–Ã¢ç’Òv—BæWrc$6W'f–6R‡'VææW"’ævWE'G”FWF–Â†–BÂv7W7FöÖW"rÂÆö6F–öä–B“°¢–b‚FWF–Â’F‡&÷ræWrW'&÷"‚t7W7FöÖW"æ÷Bf÷VæBr“°¢&WGW&âFWF–Ã°¢ÒÀ¢7&VFTFV'F÷#¢†C¢ç’’Óâ’æ7&VFU'G’‡²ââæBÂ&öÆW3¢²v7W7FöÖW"uÒÒ’À¢WFFTFV'F÷#¢7–æ2†–C¢7G&–ærÂC¢ç’’Óâ°¢6öç7B'VææW"Ò7F—fU7Å'VææW"‚“²–b‚'VææW"’F‡&÷ræWrW'&÷"‚uc"66÷VçF–ær&WV—&W25Æ—FR7F÷&vRr“°¢6öç7B6W'f–6RÒæWrc$6W'f–6R‡'VææW"“²–b‚v—B6W'f–6RævWE'G”FWF–Â†–BÂv7W7FöÖW"r’’F‡&÷ræWrW'&÷"‚t7W7FöÖW"æ÷Bf÷VæBr“°¢&WGW&âv—F…7–æ6VD×WFF–öâ‡'VææW"Â²6öÖÖæEG—S¢w'G’çF6‚rÂvw&VvFUG—S¢w'G’rÂvw&VvFT–C¢–BÂ–ÆöC¢²–BÂF6ƒ¢BÒÒÂ‚’Óâ6W'f–6RçWFFU'G’†–BÂB’“°¢ÒÀ¢FVÆWFTFV'F÷#¢7–æ2†–C¢7G&–ær’Óâ°¢6öç7B'VææW"Ò7F—fU7Å'VææW"‚“²–b‚'VææW"’F‡&÷ræWrW'&÷"‚uc"66÷VçF–ær&WV—&W25Æ—FR7F÷&vRr“°¢6öç7B6W'f–6RÒæWrc$6W'f–6R‡'VææW"“²–b‚v—B6W'f–6RævWE'G”FWF–Â†–BÂv7W7FöÖW"r’’F‡&÷ræWrW'&÷"‚t7W7FöÖW"æ÷Bf÷VæBr“°¢&WGW&âv—F…7–æ6VD×WFF–öâ‡'VææW"Â²6öÖÖæEG—S¢w'G’æ&6†—fRrÂvw&VvFUG—S¢w'G’rÂvw&VvFT–C¢–BÂ–ÆöC¢²–BÒÒÂ‚’Óâ6W'f–6Ræ&6†—fU'G’†–B’“°¢ÒÀ¢vWDFV'F÷%7FFVÖVçC¢7–æ2†–C¢7G&–ærÂÆö6F–öä–Có¢7G&–ær’Óâ°¢6öç7B'VææW"Ò7F—fU7Å'VææW"‚“²–b‚'VææW"’F‡&÷ræWrW'&÷"‚uc"66÷VçF–ær&WV—&W25Æ—FR7F÷&vRr“°¢6öç7BFWF–Ã¢ç’Òv—BæWrc$6W'f–6R‡'VææW"’ævWE'G”FWF–Â†–BÂv7W7FöÖW"rÂÆö6F–öä–B“°¢–b‚FWF–Â’F‡&÷ræWrW'&÷"‚t7W7FöÖW"æ÷Bf÷VæBr“°¢&WGW&âFWF–Âç7FFVÖVçC°¢ÒÀ¢òòFFR×&ævR&W÷'G0¢æÅ&ævS¢7–æ2†g&öÓ¢7G&–ærÂFó¢7G&–ær’Óâ°¢6öç7B&W÷'BÒv—Bc%&W÷'B†g&öÒÂFò“°¢6öç7BF—7Æ’Ò'FæW'6†—F—7Æ”g&öÕ&W÷'G2‡&W÷'BÂv—BÆ—fT6öÖÖ—76–öå7B‚’“°¢&WGW&â°¢&WfVçVS¢&W÷'Bç&öf—DæDÆ÷72ç&WfVçVRÀ¢W&6†6W3¢&W÷'Bç&öf—DæDÆ÷72æ6öw2À¢6öw3¢&W÷'Bç&öf—DæDÆ÷72æ6öw2À¢w&÷75&öf—C¢&W÷'Bç&öf—DæDÆ÷72æw&÷75&öf—BÀ¢W‡Vç6W3¢F—7Æ’æ÷W&F–ætW‡Vç6W2À¢ÖævW$6öÖÖ—76–öå7C¢F—7Æ’æÖævW$6öÖÖ—76–öå7BÀ¢6öÖÖ—76–öã¢F—7Æ’æ6öÖÖ—76–öâÀ¢æWE&öf—C¢F—7Æ’ææWE&öf—BÀ¢Ó°¢ÒÀ¢7&VF—F÷'5&W÷'C¢7–æ2…ög&öÓó¢7G&–ærÂ÷Fóó¢7G&–ærÂÆö6F–öä–Có¢7G&–ær’Óâ†v—B’æÆ—7E7WÆ–W'2†Æö6F–öä–B’’æÖ‚‡'G“¢ç’’Óâ‡²–C¢'G’æ–BÂæÖS¢'G’ææÖRÂ&Ææ6S¢'G’ç–&ÆRÇÂ'G’æ&Ææ6RÇÂÂÆö6F–öä–C¢Æö6F–öä–BÇÂVæFVf–æVBÒ’’À¢FV'F÷'5&W÷'C¢7–æ2…ög&öÓó¢7G&–ærÂ÷Fóó¢7G&–ærÂÆö6F–öä–Có¢7G&–ær’Óâ†v—B’æÆ—7DFV'F÷'2†Æö6F–öä–B’’æÖ‚‡'G“¢ç’’Óâ‡²–C¢'G’æ–BÂæÖS¢'G’ææÖRÂ&Ææ6S¢'G’ç&V6V—f&ÆRÇÂ'G’æ&Ææ6RÇÂÂÆö6F–öä–C¢Æö6F–öä–BÇÂVæFVf–æVBÒ’’À ¢òò–çfö–6W0¢Æ—7D–çfö–6W3¢7–æ2‚’Óâ°¢–b†—5vV%'VçF–ÖR’&WGW&âF"æÆ—7D–çfö–6W2‚“°¢6öç7B'VææW"Ò7F—fU7Å'VææW"‚“²–b‚'VææW"’F‡&÷ræWrW'&÷"‚uc"66÷VçF–ær&WV—&W25Æ—FR7F÷&vRr“°¢6öç7B6W'f–6RÒæWrc$6W'f–6R‡'VææW"“°¢6öç7B7FGW6W2ÒæWrÖ‚†v—B6W'f–6RæÆ—7E6ÆW4æD–çfö–6W2‚’’æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rçG—RÓÓÒv–çfö–6Rr’æÖ‚‡&÷s¢ç’’Óâ·&÷ræ–BÂ&÷uÒ’“°¢&WGW&â†v—Bc%6÷W&6TFö7VÖVçG2…²v–çfö–6RuÒ’’æÖ‚‡&÷s¢ç’’Óâ°¢6öç7BÆ—fS¢ç’Ò7FGW6W2ævWB‡&÷ræ–B“°¢&WGW&â²ââç&÷rÂ–çfö–6TçVÖ&W#¢&÷rç&VfW&Væ6RÇÂ&÷ræ–BÂ7FGW3¢Æ—fSòç7FGW2ÇÂ&÷rç7FGW2ÇÂwVç–BrÂ÷VäÖ÷VçC¢Æ—fSòæ÷VäÖ÷VçBóò&÷rçF÷FÂÂÆ–æW3¢'&’æ—4'&’‡&÷ræÆ–æW2’ò&÷ræÆ–æW2¢µÒÓ°¢Ò“°¢ÒÀ¢7&VFT–çfö–6S¢†–çc¢ç’’Óâ—5vV%'VçF–ÖRòF"æ7&VFT–çfö–6R†–çb’çF†Vâ‚‡&W7VÇB’Óâ²'V×FFfW'6–öâ‚“²&WGW&â&W7VÇC²Ò’¢7&VFUG&ç67F–öâ‚v7&VFT–çfö–6RrÂ–çb’À¢WFFT–çfö–6S¢†–C¢7G&–ærÂ–çc¢ç’’Óâ—5vV%'VçF–ÖRòF"çWFFT–çfö–6R†–BÂ–çb’çF†Vâ‚‡&W7VÇB’Óâ²'V×FFfW'6–öâ‚“²&WGW&â&W7VÇC²Ò’¢×WFFUG&ç67F–öâ‚wWFFT–çfö–6RrÂ–BÂ–çb’À¢FVÆWFT–çfö–6S¢†–C¢7G&–ær’Óâ—5vV%'VçF–ÖRòF"æFVÆWFT–çfö–6R†–B’çF†Vâ‚‡&W7VÇB’Óâ²'V×FFfW'6–öâ‚“²&WGW&â&W7VÇC²Ò’¢×WFFUG&ç67F–öâ‚vFVÆWFT–çfö–6RrÂ–B’À¢Ö&´–çfö–6U–C¢†–C¢7G&–ærÂ–çWCó¢ç’’Óâ—5vV%'VçF–ÖRòF"æÖ&´–çfö–6U–B†–B’çF†Vâ‚‡&W7VÇB’Óâ²'V×FFfW'6–öâ‚“²&WGW&â&W7VÇC²Ò’¢×WFFUG&ç67F–öâ‚vÖ&´–çfö–6U–BrÂ–BÂ²âââ†–çWBÇÂ·Ò’ÂFFS¢–çWCòæFFRÇÂÆö6ÅFöF”—6ò‚’ÂÖWF†öC¢–çWCòæÖWF†öBÇÂv66‚rÒ’À¢÷fW&GVT–çfö–6W3¢7–æ2‚’Óâ†v—B’æÆ—7D–çfö–6W2‚’’æf–ÇFW"‚†–çfö–6S¢ç’’Óâ–çfö–6Rç7FGW2ÓÒw–Brbb–çfö–6RæGVTFFRbb–çfö–6RæGVTFFRÂÆö6ÅFöF”—6ò‚’’À ¢òò&V6V—G2†ÖöæW’7GVÆÇ’&V6V—fVB¢Æ—7E&V6V—G3¢7–æ2‚’Óâ°¢–b†—5vV%'VçF–ÖR’&WGW&âF"æÆ—7E&V6V—G2‚“°¢6öç7B'VææW"Ò7F—fU7Å'VææW"‚“²–b‚'VææW"’F‡&÷ræWrW'&÷"‚uc"66÷VçF–ær&WV—&W25Æ—FR7F÷&vRr“°¢6öç7B&V6V—G2Òv—Bc%6÷W&6TFö7VÖVçG2…²w&V6V—BuÒ“°¢6öç7B–G2Ò&V6V—G2æÖ‚‡&÷s¢ç’’Óâ&÷ræ–B“°¢6öç7BÆÆö6F–öç2Ò–G2æÆVæwF‚òv—B'VææW"æÆÃÆç“â†4TÄT5B&V6V—E÷6÷W&6Uö–BÆ–çfö–6U÷6÷W&6Uö–BÆÖ÷VçBe$ôÒc%ö–çfö–6UöÆÆö6F–öç2t„U$R&V6V—E÷6÷W&6Uö–B”â‚G¶–G2æÖ‚‚’Óâsòr’æ¦ö–â‚rÂr—Ò–Â–G2’¢µÓ°¢&WGW&â&V6V—G2æÖ‚‡&÷s¢ç’’Óâ‡²ââç&÷rÂ&V6V—DçVÖ&W#¢&÷rç&VfW&Væ6RÇÂ&÷ræ–BÂFV'F÷$–C¢&÷rç'G”–BÂÖöFS¢&÷ræÖöFRÇÂ„çVÖ&W"‡&÷ræGfæ6R’âòvGfæ6Rr¢vv–ç7Eö–çfö–6Rr’ÂÆÆö6F–öç3¢ÆÆö6F–öç2æf–ÇFW"‚†—FVÓ¢ç’’Óâ—FVÒç&V6V—E÷6÷W&6Uö–BÓÓÒ&÷ræ–B’æÖ‚†—FVÓ¢ç’’Óâ‡²–çfö–6T–C¢—FVÒæ–çfö–6U÷6÷W&6Uö–BÂ–çfö–6U6÷W&6T–C¢—FVÒæ–çfö–6U÷6÷W&6Uö–BÂÖ÷VçDÆ–VC¢çVÖ&W"†—FVÒæÖ÷VçB’ÂÖ÷VçC¢çVÖ&W"†—FVÒæÖ÷VçB’Ò’’Ò’“°¢ÒÀ¢7&VFU&V6V—C¢‡#¢ç’’Óâ—5vV%'VçF–ÖRòF"æ7&VFU&V6V—B‡"’çF†Vâ‚‡&W7VÇB’Óâ²'V×FFfW'6–öâ‚“²&WGW&â&W7VÇC²Ò’¢7&VFUG&ç67F–öâ‚v7&VFU&V6V—BrÂ"’À¢WFFU&V6V—C¢†–C¢7G&–ærÂ–çWC¢ç’’Óâ—5vV%'VçF–ÖRòF"çWFFU&V6V—B†–BÂ–çWB’çF†Vâ‚‡&W7VÇB’Óâ²'V×FFfW'6–öâ‚“²&WGW&â&W7VÇC²Ò’¢×WFFUG&ç67F–öâ‚wWFFU&V6V—BrÂ–BÂ–çWB’À¢FVÆWFU&V6V—C¢†–C¢7G&–ær’Óâ—5vV%'VçF–ÖRòF"æFVÆWFU&V6V—B†–B’çF†Vâ‚‡&W7VÇB’Óâ²'V×FFfW'6–öâ‚“²&WGW&â&W7VÇC²Ò’¢×WFFUG&ç67F–öâ‚vFVÆWFU&V6V—BrÂ–B’À¢–çfö–6U–DÖ÷VçC¢7–æ2†–çfö–6T–C¢7G&–ær’Óâ°¢–b†—5vV%'VçF–ÖR’&WGW&âF"æ–çfö–6U–DÖ÷VçB†–çfö–6T–B“°¢6öç7B'VææW"Ò7F—fU7Å'VææW"‚“²–b‚'VææW"’F‡&÷ræWrW'&÷"‚uc"66÷VçF–ær&WV—&W25Æ—FR7F÷&vRr“°¢6öç7B&÷rÒv—B'VææW"æf—'7CÇ²F÷FÃ¢çVÖ&W"Óâ‚u4TÄT5B4ôÄU44R…5TÒ†Ö÷VçB’Ã’F÷FÂe$ôÒc%ö–çfö–6UöÆÆö6F–öç2t„U$R–çfö–6U÷6÷W&6Uö–CÓòrÂ¶–çfö–6T–EÒ“°¢&WGW&âçVÖ&W"‡&÷sòçF÷FÂÇÂ“°¢ÒÀ ¢òòV÷FW2òW7F–ÖFW2†æöâ×÷7F–ærVçF–Â6öçfW'FVB¢Æ—7EV÷FW3¢‚’ÓâF"æÆ—7EV÷FW2‚’À¢7&VFUV÷FS¢7–æ2‡¢ç’’Óâ²6öç7B"Òv—BF"æ7&VFUV÷FR‡“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀ¢WFFUV÷FS¢7–æ2†–C¢7G&–ærÂ¢ç’’Óâ²6öç7B"Òv—BF"çWFFUV÷FR†–BÂ“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀ¢FVÆWFUV÷FS¢7–æ2†–C¢7G&–ær’Óâ²6öç7B"Òv—BF"æFVÆWFUV÷FR†–B“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀ¢6WEV÷FU7FGW3¢7–æ2†–C¢7G&–ærÂ7FGW3¢ç’’Óâ²6öç7B"Òv—BF"ç6WEV÷FU7FGW2†–BÂ7FGW2“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀ¢6öçfW'EV÷FUFô–çfö–6S¢7–æ2†–C¢7G&–ærÂ÷G3ó¢ç’’Óâ°¢òò´f–æF–ær%Ò&÷WFRF†R–çfö–6R7&VF–öâF‡&÷Vv‚F†R4ÔRc"w&—FRF‚F†P¢òò–çfö–6W267&VVâW6W26òF†R6öçfW'FVB–çfö–6R—2f—6–&ÆRFòF†Rc"ÆVFvW ¢òò†F6†&ö&BÂ&W÷'G2Â'G’FWF–Â’(	Bæ÷B7G&æFVB÷WG6–FRF†RÆVFvW"à¢6öç7B"Òv—BF"æ6öçfW'EV÷FUFô–çfö–6R†–BÂ÷G2Â‡–ÆöC¢ç’’Óâ7&VFUG&ç67F–öâ‚v7&VFT–çfö–6RrÂ–ÆöB’“°¢'V×FFfW'6–öâ‚“°¢&WGW&â#°¢ÒÀ ¢òò7&VF—BòFV&—Bæ÷FW2‡÷7B×6ÆRF§W7FÖVçG3¢F—66÷VçG2Â&WGW&ç2ÂW‡G&6†&vW2¢7&VFT7&VF—Dæ÷FS¢7–æ2†ã¢ç’’Óâ7&VFTæ÷FR‚v7&VFT7&VF—Dæ÷FRrÂâ’À¢7&VFTFV&—Dæ÷FS¢7–æ2†ã¢ç’’Óâ7&VFTæ÷FR‚v7&VFTFV&—Dæ÷FRrÂâ’À¢WFFTæ÷FS¢7–æ2†–C¢7G&–ærÂã¢ç’’Óâ×WFFUG&ç67F–öâ‚wWFFTæ÷FRrÂ–BÂâ’À¢FVÆWFTæ÷FS¢7–æ2†–C¢7G&–ær’Óâ×WFFUG&ç67F–öâ‚vFVÆWFTæ÷FRrÂ–B’À ¢òòFVÆ—fW'’æ÷FW2ò6†ÆÆç2†vööG2Ö÷fVÖVçBÂæòÆVFvW"÷7F–ær¢Æ—7DFVÆ—fW'”æ÷FW3¢‚’ÓâF"æÆ—7DFVÆ—fW'”æ÷FW2‚’À¢7&VFTFVÆ—fW'”æ÷FS¢7–æ2†ã¢ç’’Óâ²6öç7B"Òv—BF"æ7&VFTFVÆ—fW'”æ÷FR†â“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀ¢WFFTFVÆ—fW'”æ÷FS¢7–æ2†–C¢7G&–ærÂã¢ç’’Óâ²6öç7B"Òv—BF"çWFFTFVÆ—fW'”æ÷FR†–BÂâ“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀ¢FVÆWFTFVÆ—fW'”æ÷FS¢7–æ2†–C¢7G&–ær’Óâ²6öç7B"Òv—BF"æFVÆWFTFVÆ—fW'”æ÷FR†–B“²'V×FFfW'6–öâ‚“²&WGW&â#²ÒÀ ¢òòVæ†æ6VB&W÷'G0¢F…&W÷'C¢7–æ2†g&öÓ¢7G&–ærÂFó¢7G&–ær’Óâ°¢6öç7B·6WGF–æw2Â6öæf–rÂ–çfö–6W2Â66…6ÆW2Â&V6V—G2Â&–ÆÇ2Â7&VF—Dæ÷FW2Â&W÷'EÒÒv—B&öÖ—6RæÆÂ…°¢’ævWE6WGF–æw2‚’Â’ævWEc$&öö´6öæf–r‚’Âc%6÷W&6TFö7VÖVçG2…²v–çfö–6RuÒ’Âc%6÷W&6TFö7VÖVçG2…²v66…÷6ÆRuÒ’Âc%6÷W&6TFö7VÖVçG2…²w&V6V—BuÒ’Âc%6÷W&6TFö7VÖVçG2…²v66…÷W&6†6RrÂv7&VF—E÷W&6†6RuÒ’Âc%6÷W&6TFö7VÖVçG2…²v7&VF—Eöæ÷FRuÒ’Âc%&W÷'B†g&öÒÂFò’æ6F6‚‚‚’ÓâçVÆÂ’À¢Ò“°¢6öç7B–å&ævRÒ‡&÷s¢ç’’Óâ&÷ræFFRãÒg&öÒbb&÷ræFFRÃÒFó°¢6öç7BF„öbÒ†w&÷73¢çVÖ&W"Â&FS¢çVÖ&W"’Óâ&FRâòÖF‚ç&÷VæB‚†w&÷72Òw&÷72òƒ²&FRò’’¢’ò¢°¢6öç7B&6—2Ò6öæf–sòæ&6—2ÓÓÒv66‚ròv66‚r¢v67'VÂs°¢6öç7B&FRÒçVÖ&W"‡6WGF–æw2çF…&FRÇÂ“° ¢ÆWB÷WGWD&6RÒ°¢ÆWB÷WGWEF‚Ò°¢–b†&6—2ÓÓÒv67'VÂr’°¢6öç7B6ÆW5&÷w2Ò²ââæ–çfö–6W2Âââæ66…6ÆW5Òæf–ÇFW"†–å&ævR“°¢f÷"†6öç7B&÷röb6ÆW5&÷w2’°¢6öç7BF÷FÂÒçVÖ&W"‡&÷rçF÷FÂÇÂ&÷ræÖ÷VçBÇÂ“°¢6öç7B&÷uF‚ÒçVÖ&W"‡&÷rçF‚óò&÷ræÖWFFFòçF‚óò‡&÷rçF…&FRòF„öb‡F÷FÂÂçVÖ&W"‡&÷rçF…&FR’’¢’“°¢6öç7B&6RÒçVÖ&W"‡&÷rç7V'F÷FÂóò&÷ræÖWFFFòç7V'F÷FÂóò‡F÷FÂÒ&÷uF‚’“°¢÷WGWD&6R³Ò&6S°¢÷WGWEF‚³Ò&÷uFƒ°¢Ğ¢ÒVÇ6R°¢6öç7B66…&÷w2Ò²ââæ66…6ÆW2Âââç&V6V—G5Òæf–ÇFW"†–å&ævR“°¢f÷"†6öç7B&÷röb66…&÷w2’°¢6öç7BF÷FÂÒçVÖ&W"‡&÷rçF÷FÂÇÂ&÷ræÖ÷VçBÇÂ“°¢6öç7B&÷uF‚ÒçVÖ&W"‡&÷rçF‚óò&÷ræÖWFFFòçF‚óò‡&÷rçF…&FRòF„öb‡F÷FÂÂçVÖ&W"‡&÷rçF…&FR’’¢’“°¢6öç7B&6RÒçVÖ&W"‡&÷rç7V'F÷FÂóò&÷ræÖWFFFòç7V'F÷FÂóò‡F÷FÂÒ&÷uF‚’“°¢÷WGWD&6R³Ò&6S°¢÷WGWEF‚³Ò&÷uFƒ°¢Ğ¢Ğ ¢6öç7B6å&÷w2Ò7&VF—Dæ÷FW2æf–ÇFW"†–å&ævR“°¢6öç7B7&VF—Dæ÷FUF‚Ò6å&÷w2ç&VGV6R‚‡7VÓ¢çVÖ&W"Â&÷s¢ç’’Óâ°¢6öç7BF÷FÂÒçVÖ&W"‡&÷rçF÷FÂÇÂ&÷ræÖ÷VçBÇÂ“°¢&WGW&â7VÒ²çVÖ&W"‡&÷rçF‚óò&÷ræÖWFFFòçF‚óò‡&÷rçF…&FRòF„öb‡F÷FÂÂçVÖ&W"‡&÷rçF…&FR’’¢’“°¢ÒÂ“°¢6öç7BæWD÷WGWEF‚ÒÖF‚æÖ‚ƒÂÖF‚ç&÷VæB‚†÷WGWEF‚Ò7&VF—Dæ÷FUF‚’¢’ò“° ¢6öç7B–çWE&÷w2Ò&–ÆÇ2æf–ÇFW"†–å&ævR“°¢ÆWB–çWD&6RÒ°¢ÆWB–çWEF‚Ò°¢f÷"†6öç7B&÷röb–çWE&÷w2’°¢6öç7BF÷FÂÒçVÖ&W"‡&÷ræÖ÷VçBÇÂ&÷rçF÷FÂÇÂ“°¢6öç7B&÷uF‚ÒçVÖ&W"‡&÷rçF‚óò&÷ræÖWFFFòçF‚óò‡&÷rçF…&FRòF„öb‡F÷FÂÂçVÖ&W"‡&÷rçF…&FR’’¢’“°¢6öç7B&6RÒçVÖ&W"‡&÷rç7V'F÷FÂóò&÷ræÖWFFFòç7V'F÷FÂóò‡F÷FÂÒ&÷uF‚’“°¢–çWD&6R³Ò&6S°¢–çWEF‚³Ò&÷uFƒ°¢Ğ¢–çWD&6RÒÖF‚ç&÷VæB†–çWD&6R¢’ò°¢–çWEF‚ÒÖF‚ç&÷VæB†–çWEF‚¢’ò°¢÷WGWD&6RÒÖF‚ç&÷VæB†÷WGWD&6R¢’ò°¢÷WGWEF‚ÒÖF‚ç&÷VæB†÷WGWEF‚¢’ò° ¢6öç7BvÅF„66÷VçBÒ&W÷'CòçG&–Ä&Ææ6Sòæ66÷VçG3òæf–æB‚†¢ç’’Óâæ6öFRÓÓÒs#3r“°¢6öç7BvÅF…–&ÆRÒvÅF„66÷VçBòvÅF„66÷VçBææ÷&ÖÄ&Ææ6R¢°¢6öç7BæWEF…–&ÆRÒ†&6—2ÓÓÒv67'VÂrbbvÅF„66÷VçB’òvÅF…–&ÆR¢ÖF‚ç&÷VæB‚†æWD÷WGWEF‚Ò–çWEF‚’¢’ò° ¢&WGW&â²g&öÒÂFòÂF„Æ&VÃ¢6WGF–æw2çF„Æ&VÂÇÂuF‚rÂF…&FS¢&FRÂ&6—2Â÷WGWD&6RÂ÷WGWEF‚Â7&VF—Dæ÷FUF‚ÂFV&—Dæ÷FUFƒ¢ÂæWD÷WGWEF‚Â–çWD&6RÂ–çWEF‚ÂæWEF…–&ÆRÂvÅF…–&ÆRÓ°¢ÒÀ¢6ÆW5&Vv—7FW#¢7–æ2†g&öÓ¢7G&–ærÂFó¢7G&–ær’Óâ°¢6öç7B&÷w2Ò†v—Bc%6÷W&6TFö7VÖVçG2…²v66…÷6ÆRrÂv–çfö–6RuÒ’’æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷ræFFRãÒg&öÒbb&÷ræFFRÃÒFò’æÖ‚‡&÷s¢ç’’Óâ‡²FFS¢&÷ræFFRÂG—S¢&÷rçG—RÓÓÒv–çfö–6Rròt–çfö–6Rr¢t66‚6ÆRrÂ&Vc¢&÷rç&VfW&Væ6RÇÂrrÂ'G“¢&÷rç'G”æÖRÇÂrrÂÖ÷VçC¢&÷ræÖ÷VçBÂ7FGW3¢&÷rç7FGW2Ò’“°¢6öç7B66…F÷FÂÒ&÷w2æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rçG—RÓÓÒt66‚6ÆRr’ç&VGV6R‚‡7VÓ¢çVÖ&W"Â&÷s¢ç’’Óâ7VÒ²&÷ræÖ÷VçBÂ“°¢6öç7B–çfö–6UF÷FÂÒ&÷w2æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷rçG—RÓÓÒt–çfö–6Rr’ç&VGV6R‚‡7VÓ¢çVÖ&W"Â&÷s¢ç’’Óâ7VÒ²&÷ræÖ÷VçBÂ“°¢&WGW&â²g&öÒÂFòÂ&÷w3¢&÷w2ç6÷'B‚†¢ç’Æ#¢ç’’ÓâæFFRæÆö6ÆT6ö×&R†"æFFR’’ÂF÷FÃ¢66…F÷FÂ²–çfö–6UF÷FÂÂ66…F÷FÂÂ–çfö–6UF÷FÂÂ6÷VçC¢&÷w2æÆVæwF‚Ó°¢ÒÀ¢&V6V—G5&Vv—7FW#¢7–æ2†g&öÓ¢7G&–ærÂFó¢7G&–ær’Óâ°¢6öç7B&÷w2Ò†v—B’æÆ—7E&V6V—G2‚’’æf–ÇFW"‚‡&÷s¢ç’’Óâ&÷ræFFRãÒg&öÒbb&÷ræFFRÃÒFò’æÖ‚‡&÷s¢ç’’Óâ‡²FFS¢&÷ræFFRÂ&Vc¢&÷rç&V6V—DçVÖ&W"Â'G“¢&÷ræ6Æ–VçDæÖRÇÂuvÆ²Ö–ârÂÖöFS¢&÷ræÖöFRÂÖWF†öC¢&÷ræÖWF†öBÇÂv66‚rÂÖ÷VçC¢&÷ræÖ÷VçBÒ’“°¢6öç7B'”ÖWF†öC¢&V6÷&CÇ7G&–ærÂçVÖ&W#âÒ·Ó²6öç7B'”ÖöFS¢&V6÷&CÇ7G&–ærÂçVÖ&W#âÒ·Ó°¢f÷"†6öç7B&÷röb&÷w2’²'”ÖWF†öE·&÷ræÖWF†öEÒÒ†'”ÖWF†öE·&÷ræÖWF†öEÒÇÂ’²&÷ræÖ÷VçC²'”ÖöFU·&÷ræÖöFUÒÒ†'”ÖöFU·&÷ræÖöFUÒÇÂ’²&÷ræÖ÷VçC²Ğ¢&WGW&â²g&öÒÂFòÂ&÷w3¢&÷w2ç6÷'B‚†¢ç’Æ#¢ç’’ÓâæFFRæÆö6ÆT6ö×&R†"æFFR’’Â'”ÖWF†öBÂ'”ÖöFRÂF÷FÃ¢&÷w2ç&VGV6R‚‡7VÓ¢çVÖ&W"Â&÷s¢ç’’Óâ7VÒ²&÷ræÖ÷VçBÂ’Â6÷VçC¢&÷w2æÆVæwF‚Ó°¢ÒÀ§Ó°