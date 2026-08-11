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

    expect(source).toContain('validateAssistantProposal');
    expect(source).toContain('executeAssistantProposal');
    expect(source).toMatch(/executeAssistantProposal\([\s\S]*?\{\s*confirmed:\s*true\s*\}/);
  });

  it('Ask AI does not invoke its write executor directly from the model response', () => {
    const source = readApp('ask.tsx');

    expect(source).not.toContain('await applyAction(action)');
    expect(source).toContain('proposal.action.confirmation.preview');
  });

  it('voice validates the draft before showing confirmation and executes only from the confirm handler', () => {
    const source = readApp('voice.tsx');
    const validationIndex = source.indexOf('validateAssistantProposal');
    const confirmPhaseIndex = source.indexOf('setPhase("confirm")');
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
    const start = reports.indexOf('if (core.source === "v2")');
    const end = reports.indexOf('setTb(', start);
    const v2Block = reports.slice(start, end);

    // COGS and gross profit must come from the engine's real fields, not be aliased
    // to the total-expense or net-profit figures.
    expect(v2Block).toContain('cogs: report.profitAndLoss.cogs');
    expect(v2Block).toContain('grossProfit: report.profitAndLoss.grossProfit');
    expect(v2Block).toContain('netProfit: report.profitAndLoss.netProfit');
    expect(v2Block).not.toContain('cogs: report.profitAndLoss.expenses');
    expect(v2Block).not.toContain('grossProfit: report.profitAndLoss.netProfit');
    // Operating expenses are derived as gross − net (basis-agnostic, never double-counts cogs).
    expect(v2Block).toContain('operatingExpenses: round2(report.profitAndLoss.grossProfit - report.profitAndLoss.netProfit)');
  });

  it('Settings saves authoritative V2 book, persona, and member configuration', () => {
    const source = readApp('(tabs)/settings.tsx');
    const saveStart = source.indexOf('const save = async () =>');
    const saveEnd = source.indexOf('\n  const pickLogo', saveStart);
    const save = source.slice(saveStart, saveEnd);

    expect(save).toContain('api.updateV2BookConfig');
    expect(save).toMatch(/api\.updateV2BookConfig\([\s\S]*?selectedPersonas/);
    expect(save).toMatch(/api\.updateV2BookConfig\([\s\S]*?activePersona/);
    expect(save).toMatch(/api\.updateV2BookConfig\([\s\S]*?retailPartnership/);
    expect(save).toContain('openingContribution');
    expect(save).toContain('profitSharePct');
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

  it('onboarding wires the persona selection into the settings fields featureFlags reads', () => {
    const source = readApp('onboarding.tsx');
    // The persona choice must land in fields getEnabledFeatures actually reads.
    expect(source).toMatch(/selectedPersonas:\s*v2Personas/);
    expect(source).toMatch(/activePersona:\s*v2Personas\[0\]/);
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
  it('customize-features resets to the multi-persona baseline and persists a manual override', () => {
    const source = readApp('customize-features.tsx');
    expect(source).toContain('getPersonaBaselineFeatures');
    expect(source).toMatch(/updateSettings\(\{\s*enabledFeatures/);
  });
});
