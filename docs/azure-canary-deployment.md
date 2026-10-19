# Tenant Installation and Removal

This is the supported operator path for a commercial Microsoft 365 tenant in the public Azure cloud. Installation creates billable Azure resources. It does not create or transfer an Azure subscription.

## Prepare the tenant and workstation

Use a clean committed checkout on macOS or Linux with:

- Bash 3.2 or newer;
- Azure CLI 2.60 or newer with Bicep;
- Git 2.30 or newer;
- Node.js 20 or newer and `npm`;
- `zip` and `unzip`.

The target Microsoft 365 tenant must already have an enabled Azure subscription. A Microsoft 365 tenant does not include one automatically. If necessary, an authorized billing administrator can [create an Azure subscription](https://learn.microsoft.com/azure/cost-management-billing/manage/create-subscription). The subscription and the resources created by this installer can incur charges.

Prepare these people before starting:

- an Azure administrator who is Owner, or has equivalent permission to create resources and Azure role assignments in the subscription;
- a Microsoft Entra Privileged Role Administrator who can assign the Microsoft Graph application role to the managed identity;
- a recipient who can open and confirm the Azure Action Group verification email during the installation.

The Azure and Entra administrators may be different people. They use the same terminal at different points and do not share credentials.

Install repository dependencies and verify the checkout before the tenant operation:

```sh
npm ci
./scripts/validate-baseline.sh
npm run check
npm test
```

## Prepare the five installation values

The first installation requests only these values:

| Prompt | What to supply | Where it comes from |
| --- | --- | --- |
| Deployment name | An operator-selected name containing 3–12 lowercase letters, numbers, or hyphens and beginning with a letter, for example `mst-dwnld` | Choose a stable name for this tenant installation. It determines the dedicated Resource Group and resource names. |
| Azure subscription | A number from the enabled subscriptions displayed by the installer | Sign in to the target tenant first. If the intended subscription is absent, stop and correct its tenant association or the administrator's access. |
| Azure region | An Azure location name, for example `westeurope` | List values available to the selected subscription with `az account list-locations --query "[].name" -o table`. The installer validates the entry and asks again if it is unavailable. |
| Microsoft Search region | The tenant's uppercase three- or four-letter SharePoint `siteCollection.dataLocationCode`, for example `DEU` or `EMEA` | Confirm the SharePoint/OneDrive geography in Microsoft 365 Admin Center under **Settings → Org settings → Organization profile → Data location**, then use Microsoft's [documented region discovery](https://learn.microsoft.com/sharepoint/dev/solution-guidance/multigeo-discovery) when the exact code is not already known. This lookup does not change the installer's Graph permissions. |
| Alert email address | A working mailbox whose recipient is present during installation | Azure sends this recipient a verification message. Installation cannot complete until the receiver reports `Enabled`. |

The installer repeats a prompt after a correctable invalid value. It stops for failures that require external action, such as no enabled subscription, missing tools, authentication or permission failures, incompatible resources, or an Azure or Microsoft Graph error.

## First installation

Authenticate the Azure resource administrator in the target tenant and confirm that the intended subscription is visible:

```sh
az login --tenant <target-tenant-domain> --use-device-code
az account list --query "[?state=='Enabled'].name" -o table
./scripts/install-tenant.sh
```

Do not place tenant IDs, subscription IDs, credentials, or tokens in repository files or issue comments.

The installer proceeds in this order:

1. It checks the workstation, clean Git revision, Azure session, and public Azure cloud.
2. It requests the deployment name and a numbered subscription selection.
3. For a first installation, it requests Azure region, Microsoft Search region, and alert email.
4. It compiles the infrastructure and shows a sanitized Azure `what-if` summary, Resource Group, and cost warning.
5. It changes nothing unless the operator explicitly confirms the deployment.
6. It creates one dedicated Resource Group containing the Function, managed identity, storage, monitoring, alerts, and Action Group.
7. It asks the Entra administrator to authenticate and assigns exactly `Files.ReadWrite.All` to the managed identity.
8. It asks the Azure resource administrator to authenticate again.
9. If the Action Group receiver is not already enabled, Azure sends its verification email. Confirm it, return to the terminal, and press Return. An already enabled receiver requires no input.
10. The installer deploys the package built from the verified Git commit and checks the Function, fixed settings, permissions, alerting, and watermark storage.

The preview reports only counts by change type, never Azure resource payloads or internal identifiers. After package deployment, Function state verification can wait for up to one minute while the Flex Consumption app starts.

Completion means the technical deployment passed. Scheduled runtime failures are reported by the deployed Azure Monitor alerts.

Scheduled discovery rechecks the previous 24 hours to tolerate eventual Microsoft Search indexing. Microsoft publishes no maximum indexing delay, so recordings indexed later can still be missed.

## Live recording validation

After installation, create one private, non-channel Teams meeting recording with an eligible existing recipient. Verify after a scheduled run that the recipient receives direct read access, download is allowed, no invitation email is sent, and generated sharing links are unchanged. A second scheduled run must not create a duplicate permission.

Do not use channel recordings for this validation; their access is inherited from the channel and is outside this automation.

## Upgrade and retry

Rerun the same command with the same deployment name:

```sh
./scripts/install-tenant.sh
```

For a compatible existing deployment, the installer reads region and alert configuration from Azure, shows a new preview, requests confirmation, upgrades in place, preserves the watermark and existing receiver, and repeats technical verification without waiting for a scheduled Search request.

If an earlier installation failed after creating the dedicated Resource Group, correct the reported external problem and rerun the installer. It preserves resources for diagnosis and does not roll back automatically. It refuses to adopt an unrelated or incompatible Resource Group.

## Uninstall

Run:

```sh
./scripts/uninstall-tenant.sh
```

Select the same deployment name and subscription. After explicit confirmation, the uninstaller stops the Function, asks for the Entra administrator when necessary, revokes and verifies removal of `Files.ReadWrite.All`, and deletes only the compatible dedicated Resource Group. If Graph revocation fails, the Resource Group is preserved. Previously granted direct recording permissions remain unchanged.

Shared resources, channel recordings, sovereign clouds, Windows, central SaaS, multi-tenant deployments, installer tuning, and automatic workstation setup are unsupported.

## Reproducible release package

The installer builds the deployment package from the selected committed revision. To build the same package without deploying it:

```sh
RELEASE_REVISION="$(git rev-parse --verify HEAD^{commit})"
PACKAGE_DIRECTORY="$(mktemp -d)"
./scripts/build-function-release.sh \
  "$RELEASE_REVISION" \
  "$PACKAGE_DIRECTORY/released-package.zip"
```

Untracked and modified-but-uncommitted files cannot enter the package.
