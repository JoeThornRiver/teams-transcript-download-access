#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tenant-lifecycle-common.sh"

require_environment
ask_deployment_name
select_subscription

if [[ "$(az_value 'Resource group lookup' group exists --name "$RESOURCE_GROUP")" == 'true' ]]; then
  require_compatible_installation
  AZURE_REGION="$(az_value 'Deployment configuration lookup' group show --name "$RESOURCE_GROUP" --query location -o tsv)"
  MICROSOFT_SEARCH_REGION="$(az_value 'Deployment configuration lookup' deployment sub show --name "$SUBSCRIPTION_DEPLOYMENT" --query properties.parameters.microsoftSearchRegion.value -o tsv)"
  ALERT_EMAIL_ADDRESS="$(az_value 'Alert receiver lookup' monitor action-group list --resource-group "$RESOURCE_GROUP" --query "[0].emailReceivers[?name=='operator'].emailAddress | [0]" -o tsv)"
  [[ -n "$ALERT_EMAIL_ADDRESS" ]] || ask_alert_email
else
  ask_azure_region
  ask_search_region
  ask_alert_email
fi

az_run 'Bicep compilation' bicep build --file "$REPOSITORY_ROOT/infra/tenant.bicep" --stdout >/dev/null
WHAT_IF_CHANGES="$(az_value 'Azure deployment preview' deployment sub what-if --name "$SUBSCRIPTION_DEPLOYMENT" --location "$AZURE_REGION" --template-file "$REPOSITORY_ROOT/infra/tenant.bicep" --parameters deploymentName="$DEPLOYMENT_NAME" location="$AZURE_REGION" microsoftSearchRegion="$MICROSOFT_SEARCH_REGION" alertEmailAddress="$ALERT_EMAIL_ADDRESS" --result-format ResourceIdOnly --no-pretty-print --query 'changes[].changeType' -o tsv)"
echo "Subscription: ${SUBSCRIPTION_NAME}"
echo "Dedicated resource group: ${RESOURCE_GROUP}"
echo 'Azure resources incur charges. The preview summary below is the complete proposed change.'
echo "Preview change types: $(summarize_change_types "$WHAT_IF_CHANGES")"
confirm 'Apply this installation or upgrade?' || { echo 'No Azure resources were changed.'; exit 0; }

az_run 'Azure deployment' deployment sub create --name "$SUBSCRIPTION_DEPLOYMENT" --location "$AZURE_REGION" --template-file "$REPOSITORY_ROOT/infra/tenant.bicep" --parameters deploymentName="$DEPLOYMENT_NAME" location="$AZURE_REGION" microsoftSearchRegion="$MICROSOFT_SEARCH_REGION" alertEmailAddress="$ALERT_EMAIL_ADDRESS" --output none
FUNCTION_APP_NAME="$(read_output functionAppName)"
ACTION_GROUP_NAME="$(read_output actionGroupName)"
MANAGED_IDENTITY_PRINCIPAL_ID="$(read_output managedIdentityPrincipalId)"
STORAGE_ACCOUNT_RESOURCE_ID="$(read_output storageAccountResourceId)"

login_graph_admin
assignment_count="$(graph_assignment_count)"
if [[ "$assignment_count" == '0' ]]; then
  az_run 'Graph role assignment' rest --method post --url "https://graph.microsoft.com/v1.0/servicePrincipals/${MANAGED_IDENTITY_PRINCIPAL_ID}/appRoleAssignments" --body "{\"principalId\":\"${MANAGED_IDENTITY_PRINCIPAL_ID}\",\"resourceId\":\"${GRAPH_SP_ID}\",\"appRoleId\":\"${GRAPH_ROLE_ID}\"}" --output none >/dev/null
elif [[ "$assignment_count" != '1' ]]; then
  fail 'The managed identity has incompatible Microsoft Graph application roles.'
fi
verify_graph_assignment
restore_azure_admin

RECEIVER_STATUS="$(az_value 'Alert receiver verification' monitor action-group show --resource-group "$RESOURCE_GROUP" --name "$ACTION_GROUP_NAME" --query "emailReceivers[?name=='operator'].status | [0]" -o tsv)"
if [[ "$RECEIVER_STATUS" != 'Enabled' ]]; then
  echo 'Azure sent a verification message to the configured alert receiver. Complete verification before continuing.'
  read -r -p 'Press Return after the receiver has been verified. '
  [[ "$(az_value 'Alert receiver verification' monitor action-group show --resource-group "$RESOURCE_GROUP" --name "$ACTION_GROUP_NAME" --query "emailReceivers[?name=='operator'].status | [0]" -o tsv)" == 'Enabled' ]] || fail 'The alert receiver is not Enabled.'
fi

PACKAGE_DIRECTORY="$(mktemp -d)"
trap 'rm -rf "$PACKAGE_DIRECTORY"' EXIT
"$REPOSITORY_ROOT/scripts/build-function-release.sh" "$RELEASE_REVISION" "$PACKAGE_DIRECTORY/released-package.zip"
az_run 'Function package deployment' functionapp deployment source config-zip --resource-group "$RESOURCE_GROUP" --name "$FUNCTION_APP_NAME" --src "$PACKAGE_DIRECTORY/released-package.zip" --output none

FUNCTION_STATE=''
for ((attempt=1; attempt<=12; attempt++)); do
  FUNCTION_STATE="$(az_value 'Function state verification' resource show --resource-group "$RESOURCE_GROUP" --name "$FUNCTION_APP_NAME" --resource-type Microsoft.Web/sites --query properties.state -o tsv)"
  [[ "$FUNCTION_STATE" != 'Running' ]] || break
  [[ "$attempt" == '12' ]] || sleep 5
done
[[ "$FUNCTION_STATE" == 'Running' ]] || fail 'The Function App is not running.'
[[ "$(az_value 'Function registration verification' functionapp function list --resource-group "$RESOURCE_GROUP" --name "$FUNCTION_APP_NAME" --query 'length(@)' -o tsv)" == '1' ]] || fail 'Exactly one timer Function must be registered.'
for setting in 'CANARY_TIMER_SCHEDULE=0 */5 * * * *' 'MAX_LOOKBACK_DAYS=14' 'SEARCH_INDEX_OVERLAP_MINUTES=1440' 'SEARCH_PAGE_SIZE=100'; do
  name="${setting%%=*}"; value="${setting#*=}"
  [[ "$(az_value 'Function setting verification' functionapp config appsettings list --resource-group "$RESOURCE_GROUP" --name "$FUNCTION_APP_NAME" --query "[?name=='$name'].value | [0]" -o tsv)" == "$value" ]] || fail "Unexpected ${name} setting."
done
[[ "$(az_value 'Action Group verification' monitor action-group show --resource-group "$RESOURCE_GROUP" --name "$ACTION_GROUP_NAME" --query enabled -o tsv)" == 'true' ]] || fail 'The Action Group is disabled.'
[[ "$(az_value 'Failure alert verification' monitor scheduled-query show --resource-group "$RESOURCE_GROUP" --name "${FUNCTION_APP_NAME}-failures" --query enabled -o tsv)" == 'true' ]] || fail 'The failure alert is disabled.'
[[ "$(az_value 'Storage access verification' role assignment list --assignee "$MANAGED_IDENTITY_PRINCIPAL_ID" --scope "$STORAGE_ACCOUNT_RESOURCE_ID" --role 'Storage Blob Data Owner' --query 'length(@)' -o tsv)" == '1' ]] || fail 'The managed identity cannot reach watermark storage.'

echo 'Installation or upgrade completed. Technical deployment is verified.'
