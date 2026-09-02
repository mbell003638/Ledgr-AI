import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const readApp = (relativePath: string) =>
  fs.readFileSync(path.join(root, 'app', relativePath), 'utf8');
const readSource = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

const sourceFilesUnder = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(entryPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [entryPath] : [];
  });

describe('V2 UI contracts', () => {
  it.each(['ask.tsx', 'voice.tsx'])('%s routes writes through the explicit V2 confirmation gate', (screen) => {
    const source = readApp(screen);

    expect(source).toMatch(/validateAssistantProposal|buildVoiceTransactionDraft/);
    expect(source).toContain('executeAssistantProposal');
    expect(source).toMatch(/executeAssistantProposal\([\s\S]*?\{\s*confirmed:\s*true\s*\}/);
  });

  it('Ask AI does not invoke its write executor directly from the model response', () => {
    const source = readApp('ask.tsx');

    expect(source).not.toContain('await applyAction(action)');
    expect(source).toContain('pendingProposal.action.confirmation.preview');
    expect(source).toContain('applyAction(proposal.action)');
    expect(source).toContain('applyingProposalRef.current');
  });

  it('voice validates the draft before showing confirmation and executes only from the confirm handler', () => {
    const source = readApp('voice.tsx');
    const validationIndex = source.indexOf('await buildVoiceDraft');
    const confirmPhaseIndex = source.indexOf('setPhase("confirm")', validationIndex);
    const confirmHandlerIndex = source.indexOf('const confirmSave');
    const executeIndex = source.indexOf('await executeAssistantProposal', confirmHandlerIndex);

    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(confirmPhaseIndex).toBeGreaterThan(validationIndex);
    expect(executeIndex).toBeGreaterThan(confirmHandlerIndex);
  });

  it('removes Staff and employee-report terminology and routes from production sources', () => {
    const productionFiles = [
      ...sourceFilesUnder(path.join(root, 'app')),
      ...sourceFilesUnder(path.join(root, 'src')),
    ];
    const productionSource = productionFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');

    expect(fs.existsSync(path.join(root, 'app', '(tabs)', 'employee-report.tsx'))).toBe(false);
    expect(productionSource).not.toMatch(/\bstaff\b/i);
    expect(productionSource).not.toMatch(/employee[- ]report/i);
  });

  it('exposes Custom Report from reports', () => {
    const reports = readApp('(tabs)/reports.tsx');

    expect(reports).toContain('Custom Report');
    expect(reports).toContain('/custom-report');
  });

  it('maps the true v2 profitAndLoss fields into the P&L (no lossy expenses→cogs / netProfit→grossProfit)', () => {
    const reports = readApp('(tabs)/reports.tsx');
    const start = reports.indexOf('const report = core.report');
    const end = reports.indexOf('setTb(', start);
    const v2Block = reports.slice(start, end);

    // COGS and gross profit must come from the engine's real fields, not be aliased
    // to the total-expense or net-profit figures. Displayed net is the partnership
    // overlay (journal net minus unposted manager commission), not a remapped field.
    expect(v2Block).toContain('cogs: report.profitAndLoss.cogs');
    expect(v2Block).toContain('grossProfit: report.profitAndLoss.grossProfit');
    expect(v2Block).toContain('partnershipDisplayFromReports');
    expect(v2Block).toContain('netProfit: profit.netProfit');
    expect(v2Block).toContain('operatingExpenses: profit.operatingExpenses');
    expect(v2Block).not.toContain('cogs: report.profitAndLoss.expenses');
    expect(v2Block).not.toContain('grossProfit: report.profitAndLoss.netProfit');
  });

  it('Advanced Settings owns authoritative V2 book, persona, and member configuration', () => {
    const source = readApp('(tabs)/settings.tsx');
    const advanced = readApp('advanced-settings.tsx');
    const saveStart = source.indexOf('const save = async () =>');
    const saveEnd = source.indexOf('\n  const pickLogo', saveStart);
    const save = source.slice(saveStart, saveEnd);

    expect(save).not.toContain('api.updateV2BookConfig');
    expect(source).not.toContain('Accounting Style');
    expect(advanced).toContain('api.updateV2BookConfig');
    expect(advanced).toMatch(/api\.updateV2BookConfig\([\s\S]*?selectedPersonas/);
    expect(advanced).toMatch(/api\.updateV2BookConfig\([\s\S]*?activePersona/);
    expect(advanced).toMatch(/api\.updateV2BookConfig\([\s\S]*?retailPartnership/);
    expect(advanced).toContain('openingContribution');
    expect(advanced).toContain('profitSharePct');
    expect(advanced).toContain('Accounting & Workflow');
    expect(advanced).toMatch(/api\.updateV2BookConfig\([\s\S]*?style:\s*accountingStyle/);
  });

  it('keeps preferences free of accounting state and uses V2 as the single source', () => {
    const local = readSource('src/db/local.ts');
    const opening = readSource('src/components/OpeningBalancesModal.tsx');
    const settings = readApp('(tabs)/settings.tsx');
    const advanced = readApp('advanced-settings.tsx');
    const onboarding = readApp('onboarding.tsx');

    for (const key of [
      'openingCash', 'openingInventory', 'openingCapital', 'investors', 'partnerNames',
      'extraAssets', 'extraLiabilities', 'accountingStyle', 'accountingBasis',
      'selectedPersonas', 'activePersona',
    ]) expect(local).toContain(`'${key}'`);
    expect(local).toContain('Object.entries(partial).filter(([key]) => !ACCOUNTING_SETTING_KEYS.has(key))');
    expect(local).not.toContain('clearAccountingSettings');
    expect(opening).not.toContain('api.updateSettings({');

    for (const source of [settings, advanced, onboarding]) {
      const preferenceWrites = source.match(/api\.updateSettings\(\{[\s\S]*?\}\)/g) || [];
      for (const write of preferenceWrites) {
        expect(write).not.toMatch(/\b(?:openingCash|openingInventory|openingCapital|investors|partnerNames|accountingStyle|accountingBasis|selectedPersonas|activePersona)\s*:/);
      }
    }
  });

  it('exposes flexible-by-default and optional fixed period controls, and passes the reviewed close date explicitly', () => {
    const advanced = readApp('advanced-settings.tsx');
    const inventory = readApp('inventory-form.tsx');

    for (const testId of ['period-policy-flexible', 'period-policy-fixed', 'period-fixed-start', 'period-fixed-end']) {
      expect(advanced).toContain(`testID="${testId}"`);
    }
    expect(advanced).toContain('Flexible (Recommended)');
    expect(advanced).toContain('No assumed year-end');
    expect(advanced).toMatch(/periodPolicy:\s*periodMode === "fixed"[\s\S]*?\{ mode: "flexible" \}/);

    expect(inventory).toContain('testID="active-period-policy"');
    expect(inventory).toContain('testID="input-close-date"');
    expect(inventory).toContain('Close whenever you are ready');
    expect(inventory).toContain('Permanent action: entries through the closing date will be locked');
    expect(inventory).toContain('editable={periodPolicy.mode !== "fixed"}');
    expect(inventory).toContain('await api.closePeriod(act, notes, pct, closingIso)');
  });

  it('wires TransactionDetail into core production transaction screens with all action callbacks', () => {
    for (const screen of ['sales.tsx', 'invoices.tsx', 'receipts.tsx', '(tabs)/bills.tsx']) {
      const source = readApp(screen);
      expect(source).toContain('TransactionDetail');
      expect(source).toContain('onEdit=');
      expect(source).toContain('onReversalDelete=');
      expect(source).toContain('onShare=');
      expect(source).toContain('onPrint=');
      expect(source).toContain('onMore=');
    }
  });

  it('provides a shared accessible TransactionDetail action contract', () => {
    const source = readSource('src/components/TransactionDetail.tsx');

    expect(source).toContain('export function TransactionDetail');
    expect(source).toContain('accessibilityRole="button"');
    expect(source).toContain('accessibilityLabel={label}');
    expect(source).toMatch(/accessibilityState=\{\{\s*disabled:/);
    for (const action of ['Edit', 'Reversal/Delete', 'Share', 'Print', 'More']) {
      expect(source).toContain(`label: "${action}"`);
    }
  });

  it('exposes a shared FormCard entry-form grammar', () => {
    const source = readSource('src/components/FormCard.tsx');
    expect(source).toContain('export function FormCard');
    expect(source).toContain('export function FormField');
    expect(source).toContain('export function FormActions');
  });

  it.each(['investor/[id].tsx', 'inventory-form.tsx', 'assets.tsx'])(
    '%s adopts the shared FormField/FormActions entry grammar',
    (screen) => {
      const source = readApp(screen);
      expect(source).toMatch(/from ['"]@\/src\/components\/FormCard['"]/);
      expect(source).toContain('FormField');
      expect(source).toContain('FormActions');
    }
  );

  it('onboarding writes persona selection to the authoritative V2 book configuration', () => {
    const source = readApp('onboarding.tsx');
    expect(source).toMatch(/initializeV2Book\([\s\S]*?personas:\s*v2Personas/);
    const preferences = source.slice(source.indexOf('await api.updateSettings({'), source.indexOf('markOnboarded();'));
    expect(preferences).not.toMatch(/selectedPersonas|activePersona/);
  });

  it('the dashboard filters its tile grid through getEnabledFeatures', () => {
    const source = readApp('(tabs)/index.tsx');
    expect(source).toContain('getEnabledFeatures');
    expect(source).toMatch(/getEnabledFeatures\(settings\)/);
    expect(source).toMatch(/TILES\.filter/);
  });

  it('dashboard daily-summary card and KPI tiles share the hero GlowPressable press treatment', () => {
    const dashboard = readApp('(tabs)/index.tsx');
    const ui = readSource('src/components/UI.tsx');

    // Daily-summary card is a pressable surface with the hero's exact treatment.
    expect(dashboard).toMatch(
      /<GlowPressable[^>]*\n(?:[^>]*\n)*?\s*testID="daily-card-press"[\s\S]*?pressScale=\{0\.972\}[\s\S]*?onPress=\{\(\) => router\.push\("\/daybook"\)\}/
    );
    const dailyPress = dashboard.slice(
      dashboard.indexOf('testID="daily-card-press"'),
      dashboard.indexOf('<Card style={[styles.homeSummaryCard, styles.dailyCard')
    );
    expect(dailyPress).toContain('haptic={false}');
    expect(dailyPress).toContain('clipSafe');
    expect(dailyPress).toContain('pressScale={0.972}');

    // Hero card uses the same press depth (the reference treatment).
    const heroStart = dashboard.indexOf('function AnimatedHeroCard');
    const hero = dashboard.slice(heroStart, dashboard.indexOf('export default function Dashboard'));
    expect(hero).toContain('GlowPressable');
    expect(hero).toContain('pressScale={0.972}');

    // KPI tiles render through GlowPressable with the identical press depth.
    const kpiStart = ui.indexOf('export function KpiTile');
    const kpi = ui.slice(kpiStart, ui.indexOf('export function Row'));
    expect(kpi).toContain('<GlowPressable');
    expect(kpi).toContain('pressScale={0.972}');
    expect(kpi).toContain('haptic');
  });

  it('liability defaults to due/accrued treatment and static mode removes the customization accent', () => {
    const assets = readApp('assets.tsx');
    const settings = readApp('(tabs)/settings.tsx');
    expect(assets).toContain('useState<(typeof liabilityRecognition)[number]["id"]>("expense")');
    expect(assets).toContain('Due / accrued expense');
    expect(assets).toContain('Cash received (loan)');
    expect(settings).toContain('borderColor: animationsEnabled ? theme.color.brandPrimary : theme.color.border');
  });
  it('input forms keep their fields reachable above the mobile keyboard', () => {
    const investor = readApp('investor/[id].tsx');
    const openingBalances = readSource('src/components/OpeningBalancesModal.tsx');
    const cashbook = readApp('cashbook.tsx');
    const customer = readApp('customer/[id].tsx');
    const supplier = readApp('supplier/[id].tsx');

    expect(investor).toContain("behavior={Platform.OS === 'ios' ? 'padding' : 'height'}");
    expect(investor).toContain('keyboardShouldPersistTaps="handled"');
    expect(investor).toContain("maxHeight: '88%'");
    expect(openingBalances).toContain('KeyboardAvoidingView');
    expect(openingBalances).toContain('behavior={Platform.OS === "ios" ? "padding" : "height"}');
    expect(openingBalances).toContain('keyboardShouldPersistTaps="handled"');
    expect(openingBalances).toContain('function OpeningTextInput');
    expect(openingBalances).toContain('outlineStyle: "none"');
    expect(openingBalances).toContain('borderRadius: theme.radius.input');
    expect(cashbook).toContain('behavior={Platform.OS === "ios" ? "padding" : "height"}');
    expect(customer).toContain('behavior={Platform.OS === "ios" ? "padding" : "height"}');
    expect(supplier).toContain('behavior={Platform.OS === "ios" ? "padding" : "height"}');
  });
  it('opening assets and liabilities use named dynamic rows', () => {
    const openingBalances = readSource('src/components/OpeningBalancesModal.tsx');
    expect(openingBalances).toContain('addOtherAsset');
    expect(openingBalances).toContain('Add Other Asset');
    expect(openingBalances).toContain('addOpeningLiability');
    expect(openingBalances).toContain('Add Liability');
    expect(openingBalances).toContain('Supplier / Creditor');
    expect(openingBalances).toContain('Other Liability');
    expect(openingBalances).toContain('liabilityBreakdown');
  });
  it('exposes safe corrections for scanned opening sets, capital, assets, and custom report ranges', () => {
    const assets = readApp('assets.tsx');
    const investor = readApp('investor/[id].tsx');
    const cashbook = readApp('cashbook.tsx');
    const inventory = readApp('inventory-form.tsx');
    const reports = readApp('(tabs)/reports.tsx');

    expect(assets).toContain('Opening Assets & Liabilities');
    expect(assets).toContain('edit-opening-balance-set');
    expect(assets).toContain('updateManualBalanceTransaction');
    expect(investor).toContain('updateInvestorCapital');
    expect(investor).toContain('deleteInvestorCapital');
    expect(cashbook).toContain('Number(opening?.cash || 0)');
    expect(cashbook).not.toContain('settings.openingCash');
    expect(inventory).toContain('opening?.inventory ?? v2?.openingInventory');
    expect(inventory).not.toContain('settings.openingInventory');
    expect(reports).toContain('const [customFrom');
    expect(reports).toContain('The From date must be on or before the To date');
    expect(reports).toContain('Applying custom range');
  });
  it('loads the report core first, normalizes capital data, and lazy-loads secondary segments', () => {
    const reports = readApp('(tabs)/reports.tsx');
    const coreLoad = reports.slice(reports.indexOf('const load = useCallback'), reports.indexOf('const loadSection'));

    expect(coreLoad).toContain('v2Reports({ from, to, locationId: shopId })');
    expect(coreLoad).toContain('api.dashboard(shopId)');
    expect(coreLoad).not.toContain('api.balanceSheet()');
    expect(coreLoad).not.toContain('api.monthlyProfitTrend');
    expect(coreLoad).not.toContain('api.creditorsReport');
    expect(reports).toContain('normalizeCapitalStatement');
    expect(reports).toContain('Array.isArray(value?.investors)');
    expect(reports).toContain('Array.isArray(value?.rows) ? value.rows : []');
    expect(reports).toContain('loadedVersion.current === getDataVersion()');
  });
  it('opens each balance editor in its owning context and keeps full review explicit', () => {
    const modal = readSource('src/components/OpeningBalancesModal.tsx');
    expect(readApp('cashbook.tsx')).toContain('mode="cash"');
    expect(readApp('inventory-form.tsx')).toContain('mode="inventory"');
    expect(readApp('assets.tsx')).toContain('mode="assets_liabilities"');
    expect(readApp('investor/[id].tsx')).toContain('mode="investor"');
    expect(modal).toContain('Review complete opening set');
    expect(modal).toContain('const showCash =');
    expect(modal).toContain('const showInventory =');
    expect(modal).toContain('const showAssetsLiabilities =');
    expect(modal).toContain('if (Math.abs(openingAssets - openingCredits) > 0.005)');
  });
  it('lists named opening assets and liabilities in their corresponding current-balance cards', () => {
    const assets = readApp('assets.tsx');
    expect(assets).toContain('openingAssetEntries');
    expect(assets).toContain('openingCreditorEntries');
    expect(assets).toContain('openingLiabilityEntries');
    expect(assets).toContain('total={otherAssetsTotal}');
    expect(assets).toContain('total={creditorsTotal}');
    expect(assets).toContain('total={otherLiabilitiesTotal}');
    expect(assets).toContain('entry.origin === "opening"');
  });
  it('shows investor actions when Equity Split is configured or investor ledgers already exist', () => {
    const parties = readApp('(tabs)/suppliers.tsx');
    const quick = readSource('src/components/QuickActionMenu.tsx');
    expect(parties).toContain('partnerConfigured || investors.length > 0');
    expect(parties).toContain("['all', 'customer', 'supplier', 'partner']");
    expect(quick).toContain('config?.style === "retail_partnership" || investors.length > 0');
    expect(quick).toContain('Add Business Account');
  });
  it('disables motion and haptics together and follows the device Reduce Motion setting', () => {
    const context = readSource('src/context/ThemeContext.tsx');
    const glow = readSource('src/components/GlowPressable.tsx');
    const quick = readSource('src/components/QuickActionMenu.tsx');
    const tabs = readApp('(tabs)/_layout.tsx');
    expect(context).toContain('AccessibilityInfo.isReduceMotionEnabled()');
    expect(context).toContain("addEventListener('reduceMotionChanged'");
    expect(context).toContain('const hapticsEnabled = motionEnabled');
    expect(glow).toContain('if (!motionEnabled)');
    expect(quick).toContain('if (hapticsEnabled && Platform.OS !== "web")');
    expect(tabs).toContain('if (hapticsEnabled && Platform.OS !== "web")');
    const workspace = readSource('src/components/ReorderableWorkspaceGrid.tsx');
    const glass = readSource('src/components/AnimatedGlassSurface.tsx');
    const voiceFab = readSource('src/components/VoiceFab.tsx');
    expect(workspace).toContain('!motionEnabled && {');
    expect(workspace).toContain('boxShadow: "none"');
    expect(workspace).toContain('isWeb && motionEnabled');
    expect(glow).toContain('boxShadow: "none"');
    expect(glass).toContain('boxShadow: "none"');
    expect(voiceFab).toContain('backgroundColor: theme.color.brandPrimary');
    expect(voiceFab).toContain('color={theme.color.onBrandPrimary}');
  });
  it.each(['customer/[id].tsx', 'supplier/[id].tsx'])('%s renders and edits debit / credit notes', (screen) => {
    const source = readApp(screen);
    expect(source).toContain(`${screen.startsWith('customer') ? 'r' : 't'}.kind === "credit_note"`);
    expect(source).toContain('debit_note');
    expect(source).toContain('api.updateNote');
    expect(source).toContain('api.deleteNote');
    expect(source).toContain('trash-outline');
    expect(source).toContain('onRequestClose={closeNote}');
  });
  it('keeps Ask AI history per business book, exposes clear history, and avoids the stuck Android keyboard layout', () => {
    const source = readApp('ask.tsx');
    const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
    expect(source).toContain('AsyncStorage.getItem(historyKey)');
    expect(source).toContain('askHistoryStorageKey(api.activeBookId())');
    expect(source).toContain('Clear Ask AI history');
    expect(source).toContain('enabled={Platform.OS === "ios"}');
    expect(source).toContain('behavior={Platform.OS === "ios" ? "padding" : undefined}');
    expect(source).not.toContain('behavior={Platform.OS === "ios" ? "padding" : "height"}');
    expect(source).toContain('testID="ask-pending-action-card"');
    expect(source).toContain('submitBehavior="submit"');
    expect(source).toContain('onSubmitEditing={() => send(input)}');
    expect(source).toContain('keyboardDismissMode="on-drag"');
    expect(source).toContain('setKeyboardHeight(height)');
    expect(source).toContain('composerBottomPad');
    expect(source).toContain('Platform.OS === "android" ? keyboardHeight : 0');
    expect(appConfig.expo.android.softwareKeyboardLayoutMode).toBe('resize');
    expect(appConfig.expo.android.edgeToEdgeEnabled).toBe(true);
  });
  it('offers scan retry controls and explains automatic transient retries', () => {
    const source = readApp('scan-import.tsx');
    const ai = readSource('src/db/ai.ts');
    expect(source).toContain('testID="btn-retry-analysis"');
    expect(source).toContain('Retry same document');
    expect(source).toContain('quality: 0.7');
    expect(ai).toContain('TRANSIENT_AI_STATUSES');
    expect(ai).toContain('AI_REQUEST_TIMEOUT_MS = 60_000');
    expect(ai).toContain('The prior extraction response was not valid JSON');
  });
  it('quick sales persist standardized units and optional fixed discounts', () => {
    const sale = readApp('sale-form.tsx');
    expect(sale).toContain('placeholder="Unit"');
    expect(sale).toContain('unit: l.unit.trim()');
    expect(sale).toContain('input-sale-discount');
    expect(sale).toContain('discount: totals.discount');
    expect(sale).toContain('editable={lines.length === 0}');
  });
  it('invoice and sale edit paths do not create a party immediately before updateInvoice', () => {
    const invoices = readApp('invoices.tsx');
    const sale = readApp('sale-form.tsx');
    const saveInvoice = invoices.slice(invoices.indexOf('const saveInvoice = async () =>'), invoices.indexOf('const markPaid'));
    const saveSale = sale.slice(sale.indexOf('const save = async () =>'), sale.indexOf('const remove = async () =>'));

    expect(saveInvoice).toContain('findOrCreateParty');
    expect(saveInvoice).toMatch(/if\s*\(\s*!editId\s*\)[\s\S]*?findOrCreateParty/);
    const invoiceEdit = saveInvoice.slice(saveInvoice.indexOf('if (editId)'), saveInvoice.indexOf('else await api.createInvoice'));
    expect(invoiceEdit).toContain('updateInvoice');
    expect(invoiceEdit).not.toMatch(/findOrCreateParty|ensureParty/);

    expect(saveSale).toContain('findOrCreateParty');
    expect(saveSale).toMatch(/if\s*\(\s*!editId[\s\S]*?findOrCreateParty/);
    const saleEdit = saveSale.slice(saveSale.indexOf('if (editId)'), saveSale.indexOf('} else if (saleType === "cash")'));
    expect(saleEdit).toContain('updateInvoice');
    expect(saleEdit).not.toMatch(/findOrCreateParty|ensureParty/);
  });
  it('customize-features resets to the multi-persona baseline and persists a manual override', () => {
    const source = readApp('customize-features.tsx');
    expect(source).toContain('getPersonaBaselineFeatures');
    expect(source).toMatch(/updateSettings\(\{\s*enabledFeatures/);
  });

  it('Quick Action Create Invoice opens the invoices modal, not sale-form', () => {
    const quick = readSource('src/components/QuickActionMenu.tsx');
    const invoices = readApp('invoices.tsx');
    expect(quick).toContain('title="Create Invoice"');
    expect(quick).toContain('pathname: "/invoices"');
    expect(quick).toContain('action: "create"');
    expect(quick).toContain('title="Log Sale"');
    expect(quick).toContain('navigate("/sale-form")');
    expect(invoices).toContain('params.action !== "create"');
    expect(invoices).toContain('setSelected(null)');
    expect(invoices).toContain('api.getSettings()');
  });

  it('overdueInvoices compares due dates to localTodayIso, not a UTC slice', () => {
    const apiSrc = readSource('src/api.ts');
    const localSrc = readSource('src/db/local.ts');
    expect(apiSrc).toMatch(/overdueInvoices:[\s\S]*dueDate < localTodayIso\(\)/);
    expect(apiSrc).not.toMatch(/overdueInvoices:[\s\S]*toISOString\(\)\.slice\(0,\s*10\)/);
    expect(localSrc).toMatch(/export async function overdueInvoices\(\)[\s\S]*localTodayIso\(\)/);
  });

  it('restores the Gemini / Custom AI picker with gated dialect pills and Base URL', () => {
    const advanced = readApp('advanced-settings.tsx');

    expect(advanced).toContain('Google Gemini');
    expect(advanced).toContain('voice-transcription-model');
    expect(advanced).toContain('voice-transcription-base-url');
    expect(advanced).toContain('voice-transcription-api-key');
    expect(advanced).toContain('vision-model');
    expect(advanced).toContain('Custom Provider');
    expect(advanced).toContain('OpenAI Compatible');
    expect(advanced).toContain('Anthropic Compatible');

    const pickerStart = advanced.indexOf('title="AI Provider"');
    const apiKeyStart = advanced.indexOf('API Key', pickerStart);
    const picker = advanced.slice(pickerStart, apiKeyStart);
    expect(pickerStart).toBeGreaterThanOrEqual(0);
    expect(apiKeyStart).toBeGreaterThan(pickerStart);

    // Primary picker is two explicit pills, not PROVIDERS.map over every dialect.
    // Unused leftover styles (providerTileRow) are allowed; the JSX must not map them.
    expect(picker).toContain('Google Gemini');
    expect(picker).toContain('Custom Provider');
    expect(picker).not.toMatch(/PROVIDERS\.map\s*\(/);
    expect(picker).not.toMatch(/PROVIDER_MARK\s*\[/);

    // Dialect pills appear only for custom (openai / anthropic) providers.
    const customClick =
      /if\s*\(\s*provider === ["']gemini["']\s*\)\s*(?:chooseProvider|setProvider)\(\s*["']openai["']\s*\)/.test(advanced);
    const dialectGate =
      /isCustomProvider/.test(picker) ||
      /provider === ["']openai["']\s*\|\|\s*provider === ["']anthropic["']/.test(picker) ||
      /provider !== ["']gemini["']/.test(picker);
    expect(customClick || dialectGate).toBe(true);
    expect(picker).toContain('OpenAI Compatible');
    expect(picker).toContain('Anthropic Compatible');

    const baseUrlIdx = advanced.indexOf('>Base URL</Text>', apiKeyStart);
    expect(baseUrlIdx).toBeGreaterThan(apiKeyStart);
    const baseUrlGate = advanced.slice(Math.max(0, baseUrlIdx - 240), baseUrlIdx);
    expect(baseUrlGate).toMatch(
      /isCustomProvider|provider === ["']openai["']\s*\|\|\s*provider === ["']anthropic["']|provider !== ["']gemini["']/,
    );
  });

  it('Ask AI lifts Android by keyboard height', () => {
    const source = readApp('ask.tsx');
    expect(source).toContain('keyboardDidShow');
    expect(source).toMatch(/endCoordinates|keyboardHeight/);
  });
});
