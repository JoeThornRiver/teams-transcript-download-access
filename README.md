# Teams Transcript Download Access

Teams Transcript Download Access is a tenant-local Azure automation for private Microsoft Teams meeting recordings stored in an organizer's OneDrive.

Microsoft 365 can give meeting participants view access while blocking downloads. This automation finds existing recipients on that protected sharing permission and grants them direct read access, which permits downloading the recording and transcript.

## Behavior

The scheduled Azure Function:

- discovers recent private, organizer-owned Teams recordings;
- reads recipients already present on a download-blocked specific-people permission;
- grants only missing direct `read` access;
- sends no invitation email;
- leaves Microsoft-generated sharing links unchanged;
- records a single successful-run watermark for bounded discovery.

It does not create users or guests, add new recipients, modify sharing links, process channel recordings, or remove permissions during uninstall.

## Supported deployment

The supported environment is one commercial Microsoft 365 tenant in the public Azure cloud. Each tenant receives an isolated Azure deployment with its own Function App, managed identity, storage, monitoring, and alerts.

Installation requires:

- macOS or Linux with Bash, Azure CLI, Git, Node.js 20 or newer, `npm`, `zip`, and `unzip`;
- an Azure subscription administrator who can create resources and Azure role assignments;
- a Microsoft Entra Privileged Role Administrator;
- an available recipient for the Azure alert-verification email.

Shared deployments, channel recordings, sovereign clouds, Windows installers, central multi-tenant hosting, and installer tuning are unsupported.

See [Tenant Installation and Removal](docs/azure-canary-deployment.md) for installation, validation, upgrade, retry, and uninstall.

## Permission and cost

The tenant administrator grants the deployment's managed identity exactly the Microsoft Graph application role `Files.ReadWrite.All`. The Function validates that application role before processing.

Installation creates billable Azure resources. Review the installer's sanitized deployment preview and cost warning before confirming any change.

## Development

Run the repository checks from a clean checkout:

```sh
npm ci
./scripts/validate-baseline.sh
npm run check
npm test
```

Pull requests additionally compile and validate the Azure templates, lint Markdown, check documentation links, and scan committed content for secrets.

## Project policies

- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)
- [MIT License](LICENSE)

Every change requires a prior GitHub issue. Do not include credentials, tenant identifiers, participant data, recording URLs, or private operational evidence in issues, pull requests, or repository files.
