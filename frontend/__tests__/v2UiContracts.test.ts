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
    const validationIndex = source.indexOf('const draft = await buildVoiceDraft');
    const confirmPhaseIndex = source.indexOf('setPhase("confirm")');
    const confirmHandlerIndex = source.indexOf('const confirmSave');
    const executeIndex = source.indexOf('await executeAssistantProposal', confirmHandlerIndex);

    expect(validationIndex).toBeGreaterThanOrEqual(0);
    expect(confirmPhaseIndex).toBeGreaterThan(validationIndex);
    expect(executeIndex).toBeGreaterThan(confirmHandlerIndex);
  });

  it('voice entry points match the production-safe Ask AI voice workflow', () => {
    const source = readApp('voice.tsx');
    expect(source).toContain('await api.getAIConfig()');
    expect(source).toContain('await api.transcribe');
    expect(source).not.toContain('config.provider ===');
    expect(source).toContain('Editable voice transcript');
    expect(source).toContain('testID="btn-rebuild-voice-draft"');
    expect(source).toContain('voice-open-provider-settings');
    expect(source).toContain('KeyboardAvoidingView');
    expect(source).toContain('keyboardShouldPersistTaps="handled"');

    const fab = readSource('src/components/VoiceFab.tsx');
    expect(fab).toContain('await api.getAIConfig()');
    expect(fab).toContain('Editable homepage voice transcript');
    expect(fab).toContain('testID="voice-fab-rebuild-draft"');
    expect(fab).toContain('voice-fab-open-provider-settings');
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

  it('maps the true v2 profitAndLoss fields into the P&L (no lossy expensesâ†’cogs / netProfitâ†’grossProfit)', () => {
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

  it('Settings keeps accounting configuration exclusively in Advanced Settings', () => {
    const source = readApp('(tabs)/settings.tsx');
    const saveStart = source.indexOf('const save = async () =>');
    const saveEnd = source.indexOf('\n  const pickLogo', saveStart);
    const save = source.slice(saveStart, saveEnd);

    expect(save).not.toContain('api.updateV2BookConfig');
    expect(save).toContain('api.updateSettings');
    expect(source).not.toContain('testID="accounting-configuration-summary"');
    expect(source).not.toContain('title="Accounting setup"');
    expect(source).not.toContain('read-only summary');
    expect(source).toContain('Customize Dashboard & Feature Tabs');
    expect(source).not.toContain('const SettingsNavRow');
    expect(source).toContain('backgroundColor: theme.color.surfaceSecondary');
    expect(source).toContain('name="options-outline"');
    expect(source).toContain('padding: 16');
    expect(source).toContain('accessibilityLabel="Customize Dashboard & Feature Tabs"');
    expect(source).not.toContain('Accounting Style</Text>');
    expect(source).not.toContain('Accounting Basis</Text>');
    expect(source).toContain('router.push("/advanced-settings")');
    expect(source).not.toMatch(/onPress=\{\(\) => setAccountingStyle/);
    expect(source).not.toMatch(/onPress=\{\(\) => setAccountingBasis/);
    const advanced = readApp('advanced-settings.tsx');
    expect(advanced).toContain('Accounting & Workflow');
    expect(advanced).toContain('Accounting Basis');
    expect(advanced).toContain('Accounting Style');
    expect(advanced).toContain('api.updateV2BookConfig');
    expect(advanced).toContain('styles.advancedGroup');
    expect(advanced).toContain('const AdvancedNavRow');
    expect(advanced).toContain('backgroundColor: "transparent"');
    expect(advanced).toContain('restingBorderColor="transparent"');
    expect(advanced).not.toContain('Bank Statement Preview');
    expect(advanced).not.toContain('scan-import');
    expect(advanced).toContain('Book Health');
    expect(advanced).toContain('Self-hosted Sync');
    expect(advanced).not.toContain('HostingModeCard');
    expect(advanced).toContain('ON Â· Fingerprint / PIN');
    expect(advanced).toContain('backgroundColor: "transparent"');
    expect(advanced).toContain('lineHeight: 18');
    const sync = readApp('sync-settings.tsx');
    expect(sync).toContain('padding: 16, gap: 12');
    expect(sync).toContain('marginBottom: 2');
    const theme = readSource('src/theme.ts');
    expect(theme).toContain("muted: '#A0AAA2'");
    expect(theme).toContain("muted: '#ADB5CC'");
    const voiceFab = readSource('src/components/VoiceFab.tsx');
    expect(voiceFab).toContain('bottom: 112');
  });

  it('all shared report and transaction documents support mobile and print layouts', () => {
    const custom = readSource('src/utils/customReportDocument.ts');
    const monthly = readSource('src/utils/reportDocument.ts');
    const statement = readSource('src/utils/statementDocument.ts');
    const transaction = readSource('src/utils/transactionActions.ts');
    expect(custom).toContain('@media screen and (max-width: 600px)');
    expect(custom).toContain('body { padding: 0 !important; }');
    expect(custom).toContain('.tb-table { break-inside: auto;');
    expect(monthly).toContain('@media screen and (max-width: 600px)');
    expect(monthly).toContain('.body-grid { display: block; }');
    expect(statement).toContain('@media screen and (max-width:600px)');
    expect(statement).toContain('.columns{grid-template-columns:1fr}');
    expect(transaction).toContain('@media screen and (max-width: 600px)');
    expect(transaction).toContain('@page { size: A4 portrait; margin: 10mm; }');
    expect(transaction).toContain('table { break-inside: auto;');
  });

  it('onboarding has one multi-location control and asks for the accounting model', () => {
    const onboarding = readApp('onboarding.tsx');
    expect(onboarding).toContain('I operate multiple stores or POS points');
    expect(onboarding).toContain('setMultiLocation');
    expect(onboarding).toContain('item.key !== "multi_location"');
    expect(onboarding).toContain('testID="onboarding-accounting-standard"');
    expect(onboarding).toContain('testID="onboarding-accounting-equity-split"');
    expect(onboarding).toContain('style: accountingStyle');
    expect(onboarding).toContain('enabled: accountingStyle === "retail_partnership"');
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
    expect(preferences).toContain("enabledFeatures: null");
    expect(preferences).toContain("enabledCapabilities: selectedCapabilities");
  });

  it('the dashboard keeps financial cards and the original Quick Workspace shortcuts without backup notices or workspace metrics', () => {
    const source = readApp('(tabs)/index.tsx');
    expect(source).not.toContain('Action needed');
    expect(source).not.toContain('Workspace metrics');
    expect(source).toContain('KpiTile label="Sales"');
    expect(source).toContain('KpiTile label="Purchases"');
    expect(source).toContain('locationId');
    expect(source).toContain('Quick Workspaces');
    expect(source).toContain('Hold any tile to organize &amp; sort');
    expect(source).not.toContain('Featured tools');
    expect(source).toContain('ReorderableWork×]ûâÚ$z{-®éÜj×&VD‚w7–æ2×6WGF–æw2çG7‚r“°Ð¢6öç7BFÖ–âÒ&VD‚w7–æ2ÖFÖ–âçG7‚r“°Ð¢6öç7B†VÇF‚Ò&VD‚w7–æ2Ö†VÇF‚çG7‚r“°Ð¢W‡V7B†Æ–÷WB’çFô6öçF–â‚væÖSÒ'7–æ2ÖFÖ–â"r“°Ð¢W‡V7B†Æ–÷WB’çFô6öçF–â‚væÖSÒ'7–æ2Ö†VÇF‚"r“°Ð¢W‡V7B‡7–æ2’çFô6öçF–â‚wFW7D”CÒ&÷Vâ×7–æ2ÖFÖ–â"r“°Ð¢W‡V7B‡7–æ2’çFô6öçF–â‚wFW7D”CÒ&÷Vâ×7–æ2Ö†VÇF‚"r“°Ð¢W‡V7B†FÖ–â’çFô6öçF–â‚u7–æ2FÖ–æ—7G&F–öâr“°Ð¢W‡V7B†FÖ–â’çFô6öçF–â‚u6fRÆö6F–öâ66÷Rr“°Ð¢W‡V7B†FÖ–â’çFô6öçF–â‚u&Wfö¶Rr“°Ð¢W‡V7B††VÇF‚’çFô6öçF–â‚wFW7D”CÒ&6†V6²×6W'fW"Ö†VÇF‚"r“°Ð¢W‡V7B††VÇF‚’çFô6öçF–â‚t6†V6²6W'fW"†VÇF‚r“°Ð¢W‡V7B††VÇF‚’çFô6öçF–â‚væWfW"7F÷&VBr“°Ð¢Ò“°Ð Ð¢—B‚v¶VW27–æ2FÖ–æ—7G&F–öâæB†VÇF‚&V†–æBF†RWF†VçF–6FVB6÷&RÖÆVFvW"wV&BrÂ‚’Óâ°Ð¢6öç7BÆ–÷WBÒ&VD‚uöÆ–÷WBçG7‚r“°Ð¢6öç7BwV&E7F'BÒÆ–÷WBæÆ7D–æFW„öb‚sÅ7F6²å&÷FV7FVBwV&C×¶6ä÷Vâ‚&6÷&UöÆVFvW""—Óâr“°Ð¢6öç7BwV&DVæBÒÆ–÷WBæ–æFW„öb‚sÂõ7F6²å&÷FV7FVCârÂwV&E7F'B“°Ð¢6öç7B&Æö6²ÒÆ–÷WBç6Æ–6R†wV&E7F'BÂwV&DVæB“°Ð¢W‡V7B†&Æö6²’çFô6öçF–â‚væÖSÒ'7–æ2ÖFÖ–â"r“°Ð¢W‡V7B†&Æö6²’çFô6öçF–â‚væÖSÒ'7–æ2Ö†VÇF‚"r“°Ð¢W‡V7B†&Æö6²’çFô6öçF–â‚væÖSÒ'7–æ2×6WGF–æw2"r“°Ð¢Ò“°Ð Ð¢—B‚w7W&f6W2GW&&ÆR7–æ2GFV×BæBW'&÷"FVÆVÖWG'’–âF†R6ö÷&F–æF÷"rÂ‚’Óâ°Ð¢6öç7B66†VÖÒ&VE6÷W&6R‚w7&2öF"÷66†VÖçG2r“°Ð¢6öç7B6ö÷&F–æF÷"Ò&VE6÷W&6R‚w7&2÷7–æ2ö6ö÷&F–æF÷"çG2r“°Ð¢W‡V7B‡66†VÖ’çFô6öçF–â‚"w7–æ5÷&öf–ÆW2rÂvÆ7E÷7–æ5öGFV×EöBr"“°Ð¢W‡V7B‡66†VÖ’çFô6öçF–â‚"w7–æ5÷&öf–ÆW2rÂvÆ7E÷7–æ5öW'&÷"r"“°Ð¢W‡V7B†6ö÷&F–æF÷"’çFô6öçF–â‚vÆ7E7–æ4GFV×DBr“°Ð¢W‡V7B†6ö÷&F–æF÷"’çFô6öçF–â‚vÆ7E7–æ4W'&÷"r“°Ð¢W‡V7B†6ö÷&F–æF÷"’çFô6öçF–â‚vÆ7E÷7–æ5öW'&÷%öBr“°Ð¢Ò“°Ð§Ò“°Ð Ð Ð¦FW67&–&R‚w&öFÖ†6W2~(	3‚7–æ2U‚6öçG&7G2rÂ‚’Óâ°Ð¢—B‚vW‡÷6W26V7W&RöæR×F–ÖRVç&öÆÆÖVçB–âF†RW6W"fÆ÷ræBFÖ–æ—7G&F÷"fÆ÷rrÂ‚’Óâ°Ð¢6öç7B6WGF–æw2Ò&VD‚w7–æ2×6WGF–æw2çG7‚r“°Ð¢6öç7BFÖ–âÒ&VD‚w7–æ2ÖFÖ–âçG7‚r“°Ð¢6öç7B&V6÷fW'’Ò&VE6÷W&6R‚w7&2÷7–æ2÷&V6÷fW'’çG2r“°Ð¢6öç7B6W'fW"Ò&VE6÷W&6R‚rââ÷7–æ2×6W'fW"÷7&2÷6W'fW"çG2r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚wFW7D”CÒ'7–æ2ÖVç&öÆÆÖVçBÖ6öFR"r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚wFW7D”CÒ'&VFVVÒ×7–æ2ÖVç&öÆÆÖVçBÖ6öFR"r“°Ð¢W‡V7B†FÖ–â’çFô6öçF–â‚t7&VFR"–çf—FF–öâr“°Ð¢W‡V7B†FÖ–â’çFô6öçF–â‚t–çf—FF–öâ6öFR&V†–æBF†R"r“°Ð¢W‡V7B‡&V6÷fW'’’çFô6öçF–â‚w&VFVVÕ7–æ4Vç&öÆÆÖVçD6öFRr“°Ð¢W‡V7B‡6W'fW"’çFô6öçF–â‚r÷c÷7–æ2öVç&öÆÆÖVçBÖ6öFW2r“°Ð¢W‡V7B‡6W'fW"’çFô6öçF–â‚r÷c÷7–æ2öVç&öÆÂÖ6öFR÷&VFVVÒr“°Ð¢Ò“°Ð Ð¢—B‚v¶VW2vÆö&Â7–æ2GFVçF–öâ6ö×7BæBÖ¶W26öæfÆ–7G2'W6–æW72×&VF&ÆRrÂ‚’Óâ°Ð¢6öç7BÆ–÷WBÒ&VD‚uöÆ–÷WBçG7‚r“°Ð¢6öç7B–æF–6F÷"Ò&VE6÷W&6R‚w7&2ö6ö×öæVçG2õ7–æ57FGW4–æF–6F÷"çG7‚r“°Ð¢6öç7B6öæfÆ–7G2Ò&VD‚w7–æ2Ö6öæfÆ–7G2çG7‚r“°Ð¢W‡V7B†Æ–÷WB’çFô6öçF–â‚u7–æ57FGW4–æF–6F÷"r“°Ð¢W‡V7B†–æF–6F÷"’çFô6öçF–â‚t÷Vâ7–æ2†VÇF‚r“°Ð¢W‡V7B†–æF–6F÷"’çFô6öçF–â‚s#ór“°Ð¢W‡V7B†6öæfÆ–7G2’çFô6öçF–â‚tf–VÆBF–ffW&Væ6W2r“°Ð¢W‡V7B†6öæfÆ–7G2’çFô6öçF–â‚tæò6WGFÆVÖVçB—26–ÆVçFÇ’÷7FVBr“°Ð¢W‡V7B†6öæfÆ–7G2’çFô6öçF–â‚w6–ÆVçBÆ7B×w&—FR×v–ç2r“°Ð¢Ò“°Ð§Ò“°Ð Ð Ð¦FW67&–&R‚s#sC“‚&V6÷&F–ær&VÖVF–F–öâ6öçG&7G2rÂ‚’Óâ°Ð¢—B‚v¶VW2öæ&ö&F–ær6öçFVçBF÷ÖÆ–væVBæB7F–öâ76–ær&W7öç6—fRrÂ‚’Óâ°Ð¢6öç7Böæ&ö&F–ærÒ&VD‚vöæ&ö&F–ærçG7‚r“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚wW6U6fT&V–ç6WG2r“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚sÅ6fT&Vf–Wr7G–ÆS×·7G–ÆW2æ6öçF–æW'ÒVFvW3×µ²'F÷%×Óâr“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚w7G–ÆS×·7G–ÆW2ç67&öÆÅf–WwÒr“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚v6öç7Bfö÷FW$&÷GFöÕFF–ærÒÖF‚æÖ‚ƒ"Â–ç6WG2æ&÷GFöÒ“²r“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚wFF–æt&÷GFöÓ¢fö÷FW$&÷GFöÕFF–ærr“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚w67&öÆÅf–Ws¢²fÆWƒ¢Òr“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚v§W7F–g”6öçFVçC¢&fÆW‚×7F'B"r“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚vfÆW„w&÷s¢r“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚t÷Vâ×’v÷&·76Rr“°Ð¢W‡V7B†öæ&ö&F–ær’ææ÷BçFô6öçF–â‚vÖ–ä†V–v‡C¢ÖF‚æÖ‚ƒÂf–Ww÷'D†V–v‡BÒ##’r“°Ð¢Ò“°Ð Ð¢—B‚w&W7F÷&W26&–Æ—G’Öv&RV–6²v÷&·76R÷&væ—¦F–öâ6öçG&öÇ2rÂ‚’Óâ°Ð¢6öç7B†öÖRÒ&VD‚r‡F'2’ö–æFW‚çG7‚r“°Ð¢6öç7Bw&–BÒ&VE6÷W&6R‚w7&2ö6ö×öæVçG2õ&V÷&FW&&ÆUv÷&·76Tw&–BçG7‚r“°Ð¢W‡V7B††öÖR’çFô6öçF–â‚wv÷&¶fÆ÷uF–ÆW4f÷"‡6WGF–æw2’r“°Ð¢W‡V7B††öÖR’çFô6öçF–â‚w6÷'EF–ÆW4'•&W6WBr“°Ð¢f÷"†6öç7B&W6WBöb²w&V6VçBrÂvg&WVVçBrÂvÇ†&WF–6ÂrÂvFVfVÇBuÒ’W‡V7B††öÖR’çFô6öçF–â†6÷'EF–ÆW4'•&W6WB‚"G·&W6WGÒ"–“°Ð¢W‡V7B††öÖR’çFô6öçF–â‚u&W6WBv÷&·76W2FòFVfVÇB÷&FW"r“°Ð¢W‡V7B††öÖR’çFô6öçF–â‚vöä÷&FW$6†ævS×¶Ö÷fUF–ÆWÒr“°Ð¢W‡V7B†w&–B’çFô6öçF–â‚v6öç7BF–ÆU&W76&ÆT6ö×öæVçC¢ç’Ò—5vV"ò&W76&ÆR¢æ–ÖFVE&W76&ÆS²r“°Ð¢W‡V7B†w&–B’çFô6öçF–â‚v6öç7B—5vV"ÒÆFf÷&Òäõ2ÓÓÒ'vV"#²r“°Ð¢W‡V7B†w&–B’çFô6öçF–â‚v&÷…6†F÷s¢&æöæR"r“°Ð¢W‡V7B†w&–B’çFô6öçF–â‚w6†F÷t÷6—G“¢r“°Ð¢W‡V7B†w&–B’çFô6öçF–â‚w6†F÷u&F—W3¢r“°Ð¢W‡V7B†w&–B’çFô6öçF–â‚vVÆWfF–öã¢r“°Ð¢W‡V7B†w&–B’çFô6öçF–â‚v÷fW&fÆ÷s¢&†–FFVâ"r“°Ð¢W‡V7B†w&–B’çFô6öçF–â‚wF†VÖRæÖ÷F–öâæÆöæu&W72¢ã#‚r“°Ð¢W‡V7B†w&–B’çFô6öçF–â‚v7F—fFTgFW$Æöæu&W72†Ö÷F–öäVæ&ÆVBò&V÷&FW$Æöæu&W72¢“““““’’r“°Ð¢Ò“°Ð Ð¢—B‚v¶VW2&—f7’–âÖæBW‡÷6W2Æö6Â6fRÆöæw6–FR6†&–ærrÂ‚’Óâ°Ð¢6öç7B6WGF–æw2Ò&VD‚r‡F'2’÷6WGF–æw2çG7‚r“°Ð¢6öç7BÆ–÷WBÒ&VD‚uöÆ–÷WBçG7‚r“°Ð¢6öç7B&—f7’Ò&VD‚w&—f7’çG7‚r“°Ð¢6öç7B&6·WÒ&VD‚v&6·W×&V6÷fW'’çG7‚r“°Ð¢6öç7BGfæ6VBÒ&VD‚vGfæ6VB×6WGF–æw2çG7‚r“°Ð¢6öç7B6†&RÒ&VE6÷W&6R‚w7&2÷WF–Ç2÷6†&RçG2r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚w&÷WFW"çW6‚‚"÷&—f7’"r“°Ð¢W‡V7B‡6WGF–æw2’ææ÷BçFô6öçF–â‚tÆ–æ¶–æræ÷VåU$Âr“°Ð¢W‡V7B†Æ–÷WB’çFô6öçF–â‚væÖSÒ'&—f7’"r“°Ð¢W‡V7B‡&—f7’’çFô6öçF–â‚tÆö6ÂÖf—'7B&—f7’r“°Ð¢W‡V7B‡&—f7’’çFô6öçF–â‚tÆVFw"&—f7’öÆ–7’r“°Ð¢W‡V7B†&6·W’çFô6öçF–â‚wFW7D”CÒ&&6·W×6fRÖFWf–6RÖ'WGFöâ"r“°Ð¢W‡V7B†&6·W’çFô6öçF–â‚wFW7D”CÒ&&6·WÖW‡÷'BÖ'WGFöâ"r“°Ð¢W‡V7B†Gfæ6VB’çFô6öçF–â‚wFW7D”CÒ&ÆVv7’×6fRÖFWf–6RÖ'WGFöâ"r“°Ð¢W‡V7B†Gfæ6VB’çFô6öçF–â‚vFôW‡÷'B‚'6fR"’r“°Ð¢W‡V7B†Gfæ6VB’çFô6öçF–â‚vFôW‡÷'B‚'6†&R"’r“°Ð¢W‡V7B†&6·W’çFô6öçF–â‚&W‡÷'DVæ7'—FVB‚w6fRr’"“°Ð¢W‡V7B†&6·W’çFô6öçF–â‚&W‡÷'DVæ7'—FVB‚w6†&Rr’"“°Ð¢W‡V7B‡6†&R’çFô6öçF–â‚vW‡÷'B7–æ2gVæ7F–öâ6fT§6öäf–ÆRr“°Ð¢W‡V7B‡6†&R’çFô6öçF–â‚u7F÷&vT66W74g&ÖWv÷&²ç&WVW7DF—&V7F÷'•W&Ö—76–öç47–æ2r“°Ð¢W‡V7B‡6†&R’çFô6öçF–â‚tf–ÆU7—7FVÒæFö7VÖVçDF—&V7F÷'’r“°Ð¢Ò“°Ð§Ò“°Ð¦FW67&–&R‚w&öFÖ†6W2ž(	3Ö–w&F–öâæB&VÆV6R6öçG&7G2rÂ‚’Óâ°Ð¢—B‚vW‡÷6W2wV&FVBÆö6Â×Fò×&—fFRÖ–w&F–öâfÆ÷ræB6fR&WGW&âF‚rÂ‚’Óâ°Ð¢6öç7BÖ–w&F–öâÒ&VD‚w&—fFR×7–æ2ÖÖ–w&F–öâçG7‚r“°Ð¢6öç7B6WGF–æw2Ò&VD‚w7–æ2×6WGF–æw2çG7‚r“°Ð¢6öç7B•6÷W&6RÒ&VE6÷W&6R‚w7&2ö’çG2r“°Ð¢6öç7BÆ–÷WBÒ&VD‚uöÆ–÷WBçG7‚r“°Ð¢W‡V7B†Ö–w&F–öâ’çFô6öçF–â‚u7F'B6fRÖ–w&F–öâr“°Ð¢W‡V7B†Ö–w&F–öâ’çFô6öçF–â‚u&WGW&âF†—2FWf–6RFòÆö6ÂÖöæÇ’ÖöFRr“°Ð¢W‡V7B†Ö–w&F–öâ’çFô6öçF–â‚væ÷BFW7G'V7F—fVÇ’&WÆ6Rr“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚t÷VâwV–FVB6WGWr“°Ð¢W‡V7B†•6÷W&6R’çFô6öçF–â‚vÖ–w&FUFõ&—fFU7–æ2r“°Ð¢W‡V7B†•6÷W&6R’çFô6öçF–â‚vÆVfU&—fFU7–æ2r“°Ð¢W‡V7B†Æ–÷WB’çFô6öçF–â‚w&—fFR×7–æ2ÖÖ–w&F–öâr“°Ð¢Ò“°Ð Ð¢—B‚v¶VW2&VÆV6R&WV—&VÖVçG2æB&öÆÆ&6²vFW2F—66÷fW&&ÆR–âF†RW6W"Ö÷væVB6¶vRrÂ‚’Óâ°Ð¢6öç7BFWÆ÷”wV–FRÒ&VE6÷W&6R‚rââ÷7–æ2×6W'fW"öFWÆ÷’õ$TDÔRæÖBr“°Ð¢6öç7B6†V6¶Æ—7BÒ&VE6÷W&6R‚rââ÷7–æ2×6W'fW"öFWÆ÷’õ$TÄT4Uô4„T4´Ä•5BæÖBr“°Ð¢6öç7B&VfÆ–v‡BÒ&VE6÷W&6R‚rââ÷7–æ2×6W'fW"öFWÆ÷’÷&VfÆ–v‡Bç6‚r“°Ð¢6öç7BGfæ6VBÒ&VE6÷W&6R‚rââ÷7–æ2×6W'fW"öFWÆ÷’ö–ç7FÆÂÖGfæ6VBç6‚r“°Ð¢W‡V7B†FWÆ÷”wV–FR’çFô6öçF–â‚râ÷&VfÆ–v‡Bç6‚Gfæ6VBr“°Ð¢W‡V7B†6†V6¶Æ—7B’çFô6öçF–â‚u&öÆÆ&6²&ö6VGW&Rr“°Ð¢W‡V7B†6†V6¶Æ—7B’çFô6öçF–â‚tÖ–æ–×VÒ&WV—&VÖVçG2r“°Ð¢W‡V7B†6†V6¶Æ—7B’çFô6öçF–â‚vgWGW&RgVÆÂ†÷7FVBU%r“°Ð¢W‡V7B‡&VfÆ–v‡B’çFô6öçF–â‚tæò6W'f–6W2vW&R7F'FVBr“°Ð¢W‡V7B†Gfæ6VB’çFô6öçF–â‚w76ÆÖöFRr“°Ð¢Ò“°Ð§Ò“°Ð Ð Ð¦FW67&–&R‚v&Vv–ææW"Öf—'7B&—fFR7–æ2T’6öçG&7G2rÂ‚’Óâ°Ð¢—B‚w&÷f–FW26–×ÆRwV–FRæB&öw&W76—fRF—66Æ÷7W&RrÂ‚’Óâ°Ð¢6öç7B6WGF–æw2Ò&VD‚w7–æ2×6WGF–æw2çG7‚r“°Ð¢6öç7BwV–FRÒ&VD‚w&—fFR×7–æ2ÖwV–FRçG7‚r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚v÷Vâ×&—fFR×7–æ2ÖwV–FRr“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚u6–×ÆR6WGWr“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚t6†ö÷6RF‚r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚t’Ç&VG’†fR6W'fW"(	B6†÷r6–vâÖ–âf–VÆG2r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚tF÷væÆöB6VÆbÖ†÷7B6¶vRr“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚wFW7D”CÒ&F÷væÆöB×6VÆbÖ†÷7B×6¶vR"r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚$÷VâwV–FVB6VÆbÖ†÷7B6WGW"“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚wFW7D”CÒ&÷Vâ×6VÆbÖ†÷7B×6WGWÖwV–FR"r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚wFW7D”CÒ&÷Vâ×&—fFR×7–æ2ÖwV–FR"r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚t6öÆÆ6R7–æ2v÷&¶fÆ÷w2r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚t6öÆÆ6R7–æ27—7FVÒ6WGF–æw2r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚t¶W–&ö&Dfö–F–æuf–Wrr“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚w67&öÆÅ&Vbæ7W'&VçCòç67&öÆÅFôVæBr“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚wFW7D”CÒ'6–vâÖ–âÖæBÖ¦ö–â×7–æ2"r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚vWF†÷&—¦TæE&VFVVÕ7–æ4Vç&öÆÆÖVçD6öFRr“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚tÆVFw"†VÇ2–÷R6†ö÷6RF†R&–v‡B6WGWâr“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚tvòFò&—fFR7–æ2r“°Ð¢Ò“°Ð§Ò“°Ð Ð Ð¦FW67&–&R‚u"&—fFR7–æ2öæ&ö&F–ær6öçG&7G2rÂ‚’Óâ°Ð¢—B‚v¶VW2"–çf—FF–öç26†÷'BÖÆ—fVBÂFö¶VâÖg&VRÂæBfÆ–FFVBrÂ‚’Óâ°Ð¢6öç7BFÖ–âÒ&VD‚w7–æ2ÖFÖ–âçG7‚r“°Ð¢6öç7B66ææW"Ò&VD‚w7–æ2×66âçG7‚r“°Ð¢6öç7B6WGF–æw2Ò&VD‚w7–æ2×6WGF–æw2çG7‚r“°Ð¢6öç7B"Ò&VE6÷W&6R‚w7&2÷7–æ2÷$Vç&öÆÆÖVçBçG2r“°Ð¢6öç7B$6öFRÒ&VE6÷W&6R‚w7&2ö6ö×öæVçG2õ7–æ5$6öFRçG7‚r“°Ð¢6öç7BÆ–÷WBÒ&VD‚uöÆ–÷WBçG7‚r“°Ð¢6öç7BwV–FRÒ&VD‚w&—fFR×7–æ2ÖwV–FRçG7‚r“°Ð¢W‡V7B†FÖ–â’çFô6öçF–â‚t7&VFR"–çf—FF–öâr“°Ð¢W‡V7B†FÖ–â’çFô6öçF–â‚u66âFò¦ö–âF†—2'W6–æW72r“°Ð¢W‡V7B†FÖ–â’çFô6öçF–â‚væWfW"6öçF–ç2F†—2FÖ–æ—7G&F÷.(	—266W72Fö¶Vâr“°Ð¢W‡V7B‡66ææW"’çFô6öçF–â‚u66â–çf—FF–öâr“°Ð¢W‡V7B‡66ææW"’çFô6öçF–â‚t6ÖW&f–Wrr“°Ð¢W‡V7B‡66ææW"’çFô6öçF–â‚u7FRâ–çf—FF–öâr“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚wFW7D”CÒ'66â×7–æ2Ö–çf—FF–öâ"r“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚vFV6öFTÆVFw%7–æ5$–çf—FRr“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚t÷væW"6WGW–çf—FF–öâr“°Ð¢W‡V7B‡6WGF–æw2’çFô6öçF–â‚u–÷Rv–ÆÂ&V6öÖRF†R÷væW"öbF†—2'W6–æW7266÷VçBâr“°Ð¢W‡V7B‡"’çFô6öçF–â‚$ÄTDu%õ5”ä5õ%ô´”äBÒvÆVFw"ç7–æ2æVç&öÆÆÖVçBr"“°Ð¢W‡V7B‡"’çFô6öçF–â‚uF†—2ÆVFw"–çf—FF–öâ†2W‡—&VBr“°Ð¢W‡V7B‡$6öFR’çFô6öçF–â‚u$6öFRçFõ7G&–ærr“°Ð¢W‡V7B†Æ–÷WB’çFô6öçF–â‚væÖSÒ'7–æ2×66â"r“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚töff–6R6ö×WFW"r“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚ue2r“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚tä2r“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚tFö6¶W"6ö×÷6Rc"r“°Ð¢Ò“°Ð Ð¢—B‚vÆ–æ·2V6‚&Vv–ææW"†÷7B6†ö–6RFòfW'6–öæVBV&Æ–26VÆbÖ†÷7B&VÆV6RrÂ‚’Óâ°Ð¢6öç7BwV–FRÒ&VD‚w&—fFR×7–æ2ÖwV–FRçG7‚r“°Ð¢6öç7BF—7G&–'WF–öâÒ&VE6÷W&6R‚w7&2÷7–æ2÷6VÆd†÷7DF—7G&–'WF–öâçG2r“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚vF÷væÆöB×6VÆbÖ†÷7BÒG¶†÷7GÒr“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚tF÷væÆöBv–æF÷w2öæRÖ6Æ–6²–ç7FÆÆW"r“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚tF÷væÆöBÖ4õ2öæRÖ6Æ–6²ÆVæ6†W"r“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚tF÷væÆöBÆ–çW‚öæRÖ6Æ–6²–ç7FÆÆW"r“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚tgFW"F†R–ç7FÆÆW"f–æ—6†W2r“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚r÷6WGWr“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚tF÷væÆöBä2ôFö6¶W"'VæFÆRr“°Ð¢W‡V7B†wV–FR’çFô6öçF–â‚t÷Vâ"–çf—FF–öâ66ææW"r“°Ð¢W‡V7B†F—7G&–'WF–öâ’çFô6öçF–â‚w&VÆV6W2öÆFW7BöF÷væÆöBöÆVFw"×6VÆf†÷7BÖ'VæFÆRçF"æw¢r“°Ð¢W‡V7B†F—7G&–'WF–öâ’çFô6öçF–â‚w&VÆV6W2öÆFW7BöF÷væÆöBöÆVFw"×6VÆf†÷7BÖ–ç7FÆÂç6‚r“°Ð¢W‡V7B†F—7G&–'WF–öâ’çFô6öçF–â‚w&VÆV6W2öÆFW7BöF÷væÆöBöÆVFw"×6VÆf†÷7BÖ–ç7FÆÂç3r“°Ð¢W‡V7B†F—7G&–'WF–öâ’çFô6öçF–â‚w&VÆV6W2öÆFW7BöF÷væÆöBöÆVFw"×6VÆf†÷7BÖ–ç7FÆÂæ&Br“°Ð¢W‡V7B†F—7G&–'WF–öâ’çFô6öçF–â‚w&VÆV6W2öÆFW7BöF÷væÆöBöÆVFw"×6VÆf†÷7BÖ–ç7FÆÂæ6öÖÖæBr“°Ð¢W‡V7B†F—7G&–'WF–öâ’çFô6öçF–â‚vv†7"æ–òöÖ&VÆÃ3c3‚öÆVFw"×6VÆbÖ†÷7B×7–æ3¦ÆFW7Br“°Ð¢W‡V7B†F—7G&–'WF–öâ’çFô6öçF–â‚vÖ&VÆÃ3c3‚ôÆVFw"Õ6VÆbÔ†÷7Br“°Ð¢Ò“°Ð Ð¢—B‚wW6W2öæR÷&væ—¦VBGfæ6VB6WGF–æw2†VFW"&÷fRF†R7—7FVÒbv÷&¶fÆ÷w26V7F–öârÂ‚’Óâ°¢6öç7BGfæ6VBÒ&VD‚vGfæ6VB×6WGF–æw2çG7‚r“°¢W‡V7B†Gfæ6VB’çFô6öçF–â‚wFW7D”CÒ&Gfæ6VB×6WGF–æw2Ö†VFW""r“°¢W‡V7B†Gfæ6VB’çFô6öçF–â‚wF—FÆSÒ$Gfæ6VB6WGF–æw2"r“°¢W‡V7B†Gfæ6VB’çFô6öçF–â‚w7V'F—FÆSÒ%v÷&·76R6öæf–wW&F–öâæBv÷&¶fÆ÷w2"r“°¢W‡V7B†Gfæ6VB’çFô6öçF–â‚v66W76–&–Æ—G”Æ&VÃÒ$&6²Fò6WGF–æw2"r“°¢W‡V7B†Gfæ6VB’çFô6öçF–â‚wF—FÆSÒ%7—7FVÒbv÷&¶fÆ÷w2"r“°¢W‡V7B†Gfæ6VB’ææ÷BçFô6öçF–â‚sÅ67&VVä†VFW"F—FÆSÒ$Gfæ6VB"7V'F—FÆSÒ%7—7FVÒbv÷&¶fÆ÷w2"óâr“°¢W‡V7B†Gfæ6VB’ææ÷BçFô6öçF–â‚wFF–æt†÷&—¦öçFÃ¢F†VÖRç76–æræÆrÂFF–æuF÷¢br“°¢W‡V7B†Gfæ6VB’çFô6öçF–â‚vGfæ6VD†VFW#¢²FF–æuF÷¢#ÂFF–æt&÷GFöÓ¢Òr“°¢W‡V7B†Gfæ6VB’çFô6öçF–â‚vGfæ6VDw&÷W¢²Ö&v–åF÷¢F†VÖRç76–æræÆrÂFF–æs¢#Òr“°¢Ò“°¢—B‚v¶VW26ö×7B×†öæRöæ&ö&F–ær6öçG&öÇ2&V6†&ÆRæB†öÖRv÷&¶fÆ÷rÆ&VÇ2w&VBrÂ‚’Óâ°Ð¢6öç7Böæ&ö&F–ærÒ&VD‚vöæ&ö&F–ærçG7‚r“°Ð¢6öç7B†öÖRÒ&VD‚r‡F'2’ö–æFW‚çG7‚r“°Ð¢6öç7Bv÷&·76RÒ&VE6÷W&6R‚w7&2ö6ö×öæVçG2õ&V÷&FW&&ÆUv÷&·76Tw&–BçG7‚r“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚vÖ–ä†V–v‡C¢CBr“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚v66W76–&–Æ—G”Æ&VÃ×¶7W'&Væ7’G·fÇVWÖÒr“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚wFövvÆT†—D&V¢²Ö–åv–GFƒ¢SÂÖ–ä†V–v‡C¢CBr“°Ð¢W‡V7B†öæ&ö&F–ær’çFô6öçF–â‚t÷W&FR×VÇF—ÆR7F÷&W2÷"õ2ö–çG2r“°Ð¢W‡V7B††öÖR’çFô6öçF–â‚v†öÖR×v÷&¶fÆ÷r×6†÷'F7WG2r“°Ð¢W‡V7B‡v÷&·76R’çFô6öçF–â‚v66W76–&–Æ—G•&öÆSÒ&'WGFöâ"r“°Ð¢W‡V7B‡v÷&·76R’çFô6öçF–â‚vçVÖ&W$ödÆ–æW3×³'Òr“°Ð¢W‡V7B‡v÷&·76R’çFô6öçF–â‚vVÆÆ—6—¦TÖöFSÒ'F–Â"r“°Ð¢W‡V7B‡v÷&·76R’çFô6öçF–â‚vfÆW…6‡&–æ³¢r“°Ð¢Ò“°Ð¢—B‚v¶VW26ö×7B&÷GFöÒ×F"Æ&VÇ2–ç6–FRF†Ræf–vF–öâ6†VÆÂrÂ‚’Óâ°Ð¢6öç7BF'2Ò&VD‚r‡F'2’õöÆ–÷WBçG7‚r“°Ð¢W‡V7B‡F'2’çFô6öçF–â‚vÖ–åv–GFƒ¢cr“°Ð¢W‡V7B‡F'2’çFô6öçF–â‚vföçE6—¦S¢r“°Ð¢W‡V7B‡F'2’çFô6öçF–â‚vÆ–æT†V–v‡C¢Br“°Ð¢W‡V7B‡F'2’çFô6öçF–â‚wF$&$—FVÕ7G–ÆS¢²&÷&FW%&F—W3¢‚r“°Ð¢Ò“°Ð¢—B‚v¶VW2Gvò×æR&W6VçFF–öâ÷BÖ–âæB6–ævÆR×æRv—F†÷WBæF—fR÷7GW&RFFrÂ‚’Óâ°Ð¢6öç7BGvõæRÒ&VE6÷W&6R‚w7&2ö6ö×öæVçG2õ&W7öç6—fUGvõæRçG7‚r“°Ð¢W‡V7B‡GvõæR’çFô6öçF–â‚w6æ6†÷BæGVÅæRbb6æ6†÷Bæ†4†–ævRr“°Ð¢W‡V7B‡GvõæR’çFô6öçF–â‚w6æ6†÷Bç÷7GW&RÓÓÒ&fÆB"ÇÂ6æ6†÷Bç÷7GW&RÓÓÒ&&öö²"r“°Ð¢W‡V7B‡GvõæR’çFô6öçF–â‚v–b‚—56fUGvõæU÷7GW&R‡6æ6†÷B’’&WGW&âÃç·&–Ö'—ÓÂóâr“°Ð¢f÷"†6öç7BW†6ÇVFVBöb²w7–æ2rÂwfö–6RrÂv–çfö–6RrÂvÖöFÂuÒ’°Ð¢W‡V7B‡GvõæR’ææ÷BçFô6öçF–â†òG¶W†6ÇVFVGÖ“°Ð¢ÐÐ¢Ò“°Ð§Ò“°Ð