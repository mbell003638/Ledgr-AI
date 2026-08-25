import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const readApp = (relativePath: string) => fs.readFileSync(path.join(root, 'app', relativePath), 'utf8');
const readSource = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Phase 7–9 remediation contracts', () => {
  it('keeps AR and AP as shared controls while exposing location-filtered party views', () => {
    const party = readSource('src/accountingV2/services/partyDomainService.ts');
    const reports = readSource('src/accountingV2/reports.ts');
    const customer = readApp('customer/[id].tsx');
    const supplier = readApp('supplier/[id].tsx');
    const api = readSource('src/api.ts');

    expect(party).toContain('async listParties(locationId?: string)');
    expect(party).toContain('async getPartyDetail(id: string, role: \'customer\' | \'supplier\', locationId?: string)');
    expect(party).toContain("COALESCE(l.location_id, json_extract(s.metadata,'$.locationId'))");
    expect(reports).toContain('locationId?: string;');
    expect(customer).toContain('testID="customer-ar-location-context"');
    expect(customer).toContain('Accounts Receivable view');
    expect(supplier).toContain('testID="supplier-ap-location-context"');
    expect(supplier).toContain('Accounts Payable view');
    expect(api).toContain('creditorsReport: async (_from?: string, _to?: string, locationId?: string)');
    expect(api).toContain('debtorsReport: async (_from?: string, _to?: string, locationId?: string)');
  });

  it('uses a persona-aware accounting-style recommendation but requires an explicit override', () => {
    const config = readSource('src/accountingV2/config.ts');
    const onboarding = readApp('onboarding.tsx');
    expect(config).toContain('defaultAccountingStyleForPersonas');
    expect(config).toContain("personas.includes('startup') ? 'retail_partnership' : 'standard'");
    expect(onboarding).toContain('accountingStyleTouched');
    expect(onboarding).toContain('chooseAccountingStyle');
    expect(onboarding).toContain('defaultAccountingStyleForPersonas([nextPersona])');
    expect(onboarding).toContain('style: accountingStyle');
  });

  it('keeps sync status and active workspace drag depth platform-correct', () => {
    const sync = readSource('src/components/SyncStatusIndicator.tsx');
    const workspace = readSource('src/components/ReorderableWorkspaceGrid.tsx');
    expect(sync).toContain("boxShadow: '0 2px 10px rgba(0,0,0,0.12)'");
    expect(sync).toContain("elevation: 6");
    expect(workspace).toContain('return isWeb');
    expect(workspace).toContain('boxShadow: "none"');
    expect(workspace).toContain('shadowOpacity: 0');
    expect(workspace).toContain('shadowRadius: 0');
    expect(workspace).toContain('elevation: 0');
  });

  it('gives reports and empty Home states accessible, context-aware actions', () => {
    const dashboard = readApp('(tabs)/index.tsx');
    const reports = readApp('(tabs)/reports.tsx');
    const customize = readApp('customize-features.tsx');
    expect(dashboard).toContain('testID="dashboard-quick-start"');
    expect(dashboard).toContain('Create your first entry');
    expect(dashboard).toContain('minHeight: 40');
    expect(reports).toContain('accessibilityRole="radio"');
    expect(reports).toContain('accessibilityState={{ selected: !locationId }}');
    expect(reports).toContain('All locations');
    expect(customize).toContain('accessibilityRole="switch"');
    expect(customize).toContain('accessibilityState={{ checked: enabled, disabled: locked }}');
  });
});
