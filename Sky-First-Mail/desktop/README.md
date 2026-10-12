# Sky First Mail — Windows Desktop

This folder builds the branded Windows desktop shell for the Sky First Mail web service. It opens the existing production web origin in a hardened, standalone Electron window. The existing Cloudflare Worker, D1, R2, login, permissions and mail transports remain the source of truth.

## Build locally (Windows)
1. Install Node.js 22 LTS.
2. Open a terminal in `desktop`.
3. Run `npm install`.
4. Run `npm run build:win`.
5. The NSIS setup file is written to `desktop/dist/Sky-First-Mail-Setup-1.0.0.exe`.

## Build through GitHub Actions
Push the project (with `desktop/`, `public/app-icon.ico`, and `.github/workflows/build-windows.yml`) to a GitHub repository, then open **Actions → Build Sky First Mail for Windows → Run workflow**. Download the `Sky-First-Mail-Windows-Setup` artifact after the run completes successfully.

The default website is `https://gmail.skyfirst.io.vn`. For a test environment, set `SKY_FIRST_MAIL_URL` before starting/building/running Electron. The service must already be deployed and reachable. This installer does not bundle a second database or a copy of the Cloudflare Worker. The installer is not code-signed; Windows SmartScreen may show a publisher warning until the organization signs releases.
