const { withAndroidManifest } = require('@expo/config-plugins');

const BLOCKED = new Set([
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.SYSTEM_ALERT_WINDOW',
]);

module.exports = function withBlockedAndroidPermissions(config) {
  return withAndroidManifest(config, (mod) => {
    const permissions = mod.modResults.manifest['uses-permission'] || [];
    mod.modResults.manifest['uses-permission'] = permissions.filter((permission) => {
      const name = permission?.$?.['android:name'];
      return !BLOCKED.has(name);
    });
    return mod;
  });
};
