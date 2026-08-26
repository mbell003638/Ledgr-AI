export const SELF_HOST_DISTRIBUTION = {
  repositoryUrl: 'https://github.com/mbell003638/Ledgr-Self-Host',
  releaseUrl: 'https://github.com/mbell003638/Ledgr-Self-Host/releases/latest',
  bundleUrl: 'https://github.com/mbell003638/Ledgr-Self-Host/releases/latest/download/ledgr-selfhost-bundle.tar.gz',
  linuxInstallerUrl: 'https://github.com/mbell003638/Ledgr-Self-Host/releases/latest/download/ledgr-selfhost-install.sh',
  windowsInstallerUrl: 'https://github.com/mbell003638/Ledgr-Self-Host/releases/latest/download/ledgr-selfhost-install.ps1',
  composeUrl: 'https://github.com/mbell003638/Ledgr-Self-Host/releases/latest/download/docker-compose.yml',
  image: 'ghcr.io/mbell003638/ledgr-self-host-sync:latest',
  releaseAssetNames: {
    bundle: 'ledgr-selfhost-bundle.tar.gz',
    linuxInstaller: 'ledgr-selfhost-install.sh',
    windowsInstaller: 'ledgr-selfhost-install.ps1',
    compose: 'docker-compose.yml',
  },
} as const;

export type SelfHostDistribution = typeof SELF_HOST_DISTRIBUTION;
