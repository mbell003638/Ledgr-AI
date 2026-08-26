# Ledgr self-host distribution

This directory is the public-release source for the customer self-host bundle.
It is intentionally separate from the private mobile-app repository. The
release workflow should publish the server as a versioned multi-architecture
container image and attach this directory as a release asset.

## Customer experience

The customer downloads the installer for their operating system, installs or
opens Docker when prompted, enters the server and OIDC details, and the wizard
starts PostgreSQL, the Ledgr sync service, and Caddy. The final screen presents
the configuration-only setup QR payload for the Ledgr mobile app.

The QR payload must contain only `serverUrl`, `oidcIssuer`, `oidcClientId`, and
optional `oidcScopes`. It must never contain an access token, refresh token,
password, database URL, or private key.

## Supported hosts

- Windows x64: Docker Desktop and PowerShell installer.
- macOS Intel and Apple silicon: Docker Desktop and shell installer.
- Linux amd64 and arm64: Docker Engine with the Compose plugin and shell installer.

The container image is published for `linux/amd64` and `linux/arm64`. Docker
Desktop transparently runs the matching image on supported Mac hardware.

## Manual fallback

The installers require Docker to be available. They do not silently install
Docker or change administrator-controlled security settings. If Docker is
missing, the installer opens the official Docker download page and explains
what is required before continuing.

Production deployments still require a public HTTPS domain, an OIDC provider,
and operator-controlled backups and restore drills. A computer on a private
LAN is suitable only when the phone can reach that LAN or an approved VPN.
