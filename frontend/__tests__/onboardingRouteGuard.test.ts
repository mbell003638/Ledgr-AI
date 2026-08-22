import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('onboarding route authorization', () => {
  const layout = read('app/_layout.tsx');
  const context = read('src/context/OnboardingContext.tsx');
  const resetScreen = read('app/advanced-settings.tsx');
  const onboarding = read('app/onboarding.tsx');
  const index = read('app/index.tsx');

  it('protects every accounting route and exposes onboarding only while setup is incomplete', () => {
    expect(layout).toContain('<Stack.Protected guard={hasOnboarded}>');
    expect(layout).toContain('<Stack.Protected guard={!hasOnboarded}>');
    expect(layout).toMatch(/<Stack\.Protected guard=\{hasOnboarded\}>[\s\S]*?<Stack\.Screen name="\(tabs\)"[\s\S]*?<Stack\.Screen name="customize-features"[\s\S]*?<\/Stack\.Protected>/);
    expect(layout).toMatch(/<Stack\.Protected guard=\{!hasOnboarded\}>[\s\S]*?<Stack\.Screen name="onboarding"[\s\S]*?<\/Stack\.Protected>/);
    expect(layout).toContain('<OnboardingGateProvider>');
  });

  it('routes only incomplete or unreadable persisted state to onboarding', () => {
    expect(context).toMatch(/catch\s*\{[\s\S]*?completed = false/);
    expect(index).toMatch(/api\.getSettings\(\)[\s\S]*?s\.hasOnboarded \? "\/\(tabs\)" : "\/onboarding"/);
    expect(index).toMatch(/catch\s*\{[\s\S]*?setDest\("\/onboarding"\)/);
  });

  it('updates the live route guard only after successful reset or onboarding persistence', () => {
    expect(resetScreen).toMatch(/await api\.factoryReset\(\);[\s\S]*?requireOnboarding\(\);[\s\S]*?router\.replace\('\/onboarding'/);
    expect(onboarding).toMatch(/await api\.updateSettings\([\s\S]*?markOnboarded\(\);[\s\S]*?router\.replace\("\/\(tabs\)"\)/);
  });

  it('moves backward between onboarding steps and releases Back on the first step for app exit', () => {
    expect(onboarding).toContain('BackHandler.addEventListener("hardwareBackPress"');
    expect(onboarding).toContain('if (step === 0) return false;');
    expect(onboarding).toContain('setStep((current) => current - 1)');
    expect(onboarding).toMatch(/if \(step === 0\) return false;[\s\S]*?return true/);
  });
});
