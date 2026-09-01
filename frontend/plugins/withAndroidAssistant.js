const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withStringsXml,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const SCHEME = 'ledgr';
const SHORTCUT_LABELS = [
  { name: 'ledgr_shortcut_ask_ai', value: 'Ask Ledgr' },
  { name: 'ledgr_shortcut_voice_assistant', value: 'Voice Assistant' },
  { name: 'ledgr_shortcut_scan_receipt', value: 'Scan receipt' },
];

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
    const metadata = activity['meta-data'] || [];
    if (!metadata.some((item) => item?.$?.['android:name'] === 'android.app.shortcuts')) {
      metadata.push({ $: { 'android:name': 'android.app.shortcuts', 'android:resource': '@xml/shortcuts' } });
    }
    activity['meta-data'] = metadata;
    return mod;
  });

  config = withStringsXml(config, (mod) => {
    mod.modResults = AndroidConfig.Strings.setStringItem(
      SHORTCUT_LABELS.map(({ name, value }) =>
        AndroidConfig.Resources.buildResourceItem({ name, value }),
      ),
      mod.modResults,
    );
    return mod;
  });

  return withDangerousMod(config, ['android', async (mod) => {
    const xmlDir = path.join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    fs.mkdirSync(xmlDir, { recursive: true });
    const shortcuts = `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:app="http://schemas.android.com/apk/res-auto">
  <capability android:name="actions.intent.OPEN_APP_FEATURE">
    <intent android:action="android.intent.action.VIEW" android:targetPackage="${config.android?.package || 'com.ahem.ledgrai'}" android:targetClass=".MainActivity">
      <url-template android:value="${SCHEME}://assistant/{feature}" />
    </intent>
  </capability>
  <capability android:name="custom.actions.intent.RECORD_PAYMENT"><intent android:action="android.intent.action.VIEW" android:targetPackage="${config.android?.package || 'com.ahem.ledgrai'}" android:targetClass=".MainActivity"><url-template android:value="${SCHEME}://assistant?action=record_payment&amp;amount={amount}&amp;counterparty={counterparty}&amp;date={date}" /><parameter android:name="amount" android:key="amount" /><parameter android:name="counterparty" android:key="counterparty" /><parameter android:name="date" android:key="date" /></intent></capability>
  <capability android:name="custom.actions.intent.RECORD_EXPENSE"><intent android:action="android.intent.action.VIEW" android:targetPackage="${config.android?.package || 'com.ahem.ledgrai'}" android:targetClass=".MainActivity"><url-template android:value="${SCHEME}://assistant?action=record_expense&amp;amount={amount}&amp;note={note}" /><parameter android:name="amount" android:key="amount" /><parameter android:name="note" android:key="note" /></intent></capability>
  <capability android:name="custom.actions.intent.RECORD_RECEIPT"><intent android:action="android.intent.action.VIEW" android:targetPackage="${config.android?.package || 'com.ahem.ledgrai'}" android:targetClass=".MainActivity"><url-template android:value="${SCHEME}://assistant?action=record_receipt" /></intent></capability>
  <capability android:name="custom.actions.intent.ADD_CAPITAL"><intent android:action="android.intent.action.VIEW" android:targetPackage="${config.android?.package || 'com.ahem.ledgrai'}" android:targetClass=".MainActivity"><url-template android:value="${SCHEME}://assistant?action=add_capital&amp;amount={amount}&amp;counterparty={counterparty}" /><parameter android:name="amount" android:key="amount" /><parameter android:name="counterparty" android:key="counterparty" /></intent></capability>
  <shortcut android:shortcutId="ask_ai" android:enabled="true" android:shortcutShortLabel="@string/ledgr_shortcut_ask_ai"><intent android:action="android.intent.action.VIEW" android:data="${SCHEME}://assistant?action=open_ask_ai" /></shortcut>
  <shortcut android:shortcutId="voice_assistant" android:enabled="true" android:shortcutShortLabel="@string/ledgr_shortcut_voice_assistant"><intent android:action="android.intent.action.VIEW" android:data="${SCHEME}://assistant?action=open_voice" /></shortcut>
  <shortcut android:shortcutId="scan_receipt" android:enabled="true" android:shortcutShortLabel="@string/ledgr_shortcut_scan_receipt"><intent android:action="android.intent.action.VIEW" android:data="${SCHEME}://assistant?action=open_scanner" /></shortcut>
</shortcuts>
`;
    fs.writeFileSync(path.join(xmlDir, 'shortcuts.xml'), shortcuts, 'utf8');
    return mod;
  }]);
};

