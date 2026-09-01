const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SCHEME = 'ledgr';

/**
 * Adds the Android entry points used by Google Assistant/App Actions.
 * All intents open the app; JavaScript validates the payload and creates a
 * review-only draft. This plugin deliberately does not register a receiver
 * that could write accounting data in the background.
 */
module.exports = function withAndroidAssistant(config) {
  config = withAndroidManifest(config, (mod) => {
    const application = mod.modResults.manifest.application?.[0];
    const activity = application?.activity?.find((item) =>
      item?.['intent-filter']?.some((filter) =>
        filter?.action?.some((action) => action?.$?.['android:name'] === 'android.intent.action.MAIN'),
      ),
    ) || application?.activity?.[0];
    if (!activity) return mod;

    const filters = activity['intent-filter'] || [];
    const hasViewFilter = filters.some((filter) =>
      filter?.action?.some((action) => action?.$?.['android:name'] === 'android.intent.action.VIEW') &&
      filter?.data?.some((data) => data?.$?.['android:scheme'] === SCHEME),
    );
    if (!hasViewFilter) {
      filters.push({
        action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
        category: [
          { $: { 'android:name': 'android.intent.category.DEFAULT' } },
          { $: { 'android:name': 'android.intent.category.BROWSABLE' } },
        ],
        data: [{ $: { 'android:scheme': SCHEME } }],
      });
    }
    activity['intent-filter'] = filters;
    return mod;
  });

  return withDangerousMod(config, ['android', async (mod) => {
    const xmlDir = path.join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    fs.mkdirSync(xmlDir, { recursive: true });
    const shortcuts = `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <capability android:name="actions.intent.OPEN_APP_FEATURE">
    <intent android:action="android.intent.action.VIEW" android:targetPackage="${config.android?.package || 'com.ahem.ledgrai'}" android:targetClass=".MainActivity">
      <url-template android:value="${SCHEME}://assistant/{feature}" />
    </intent>
  </capability>
</shortcuts>
`;
    fs.writeFileSync(path.join(xmlDir, 'shortcuts.xml'), shortcuts, 'utf8');
    return mod;
  }]);
};

