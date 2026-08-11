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

  it('fails closed if persisted onboarding state cannot be read', () => {
    expect(context).toMatch(/catch\s*\{[\s\S]*?completed = false/);
    expect(index).toMatch(/catch\s*\{[\s\S]*?setDest\("\/onboarding"\)/);
  });

  it('updates the live route guard only after successful reset or onboarding persistence', () => {
    expect(resetScreen).toMatch(/await api\.factoryReset\(\);[\s\S]*?requireOnboarding\(\);[\s\S]*?router\.replace\('\/onboarding'/);
    expect(onboarding).toMatch(/await api\.updateSettings\([\s\S]*?markOnboarded\(\);[\s\S]*?router\.replace\("\/\(tabs\)"\)/);
  });

  it('consumes Android Back inside onboarding and moves only between setup steps', () => {
    expect(onboarding).toContain('BackHandler.addEventListener("hardwareBackPress"');
    expect(onboarding).toContain('setStep((current) => current > 0 ? current - 1 : current)');
    expect(onboarding).toMatch(/hardwareBackPress[\s\S]*?return true/);
  });
});
