#!/usr/bin/env bash

set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tenant-lifecycle-common.sh"

require_environment
ask_deployment_name
select_subscription

if [[ "$(az_value 'Resource group lookup' group exists --name "$RESOURCE_GROUP")" != 'true' ]]; then
  echo 'Installation is already absent.'
  exit 0
fi
require_compatible_installation
require_owned_inventory
FUNCTION_APP_NAME="$(az resource show --resource-group "$RESOURCE_GROUP" --resource-type Microsoft.Web/sites --name "$EXPECTED_FUNCTION_APP" --query name -o tsv 2>/dev/null || true)"
MANAGED_IDENTITY_PRINCIPAL_ID="$(az identity show --resource-group "$RESOURCE_GROUP" --name "tra-${DEPLOYMENT_NAME}-identity" --query principalId -o tsv 2>/dev/null || true)"

echo "Subscription: ${SUBSCRIPTION_NAME}"
echo "Dedicated resource group: ${RESOURCE_GROUP}"
echo 'Removal revokes Files.ReadWrite.All and deletes the dedicated resource group.'
echo 'Removal stops future processing but does not remove direct recording permissions already granted.'
confirm 'Uninstall this deployment?' || { echo 'Nothing was changed.'; exit 0; }

[[ -z "$FUNCTION_APP_NAME" ]] || az_run 'Function stop' functionapp stop --resource-group "$RESOURCE_GROUP" --name "$FUNCTION_APP_NAME" --output none
if [[ -n "$MANAGED_IDENTITY_PRINCIPAL_ID" ]]; then
  login_graph_admin
  assignment_count="$(graph_assignment_count)"
  if [[ "$assignment_count" == '1' ]]; then
    verify_graph_assignment
    ASSIGNMENT_ID="$(az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals/${MANAGED_IDENTITY_PRINCIPAL_ID}/appRoleAssignments?\$select=id,resourceId" --query "value[?resourceId=='$GRAPH_SP_ID'].id | [0]" -o tsv 2>/dev/null)" || fail 'Files.ReadWrite.All could not be resolved for removal.'
    [[ -n "$ASSIGNMENT_ID" ]] || fail 'Files.ReadWrite.All could not be resolved for removal.'
    az_run 'Graph role revocation' rest --method delete --url "https://graph.microsoft.com/v1.0/servicePrincipals/${MANAGED_IDENTITY_PRINCIPAL_ID}/appRoleAssignments/${ASSIGNMENT_ID}" --output none >/dev/null
    [[ "$(graph_assignment_count)" == '0' ]] || fail 'Files.ReadWrite.All could not be revoked; the resource group was preserved.'
  elif [[ "$assignment_count" != '0' ]]; then
    fail 'Unexpected Microsoft Graph roles prevent safe removal.'
  fi
  restore_azure_admin
fi
az_run 'Resource group deletion' group delete --name "$RESOURCE_GROUP" --yes
[[ "$(az_value 'Resource group deletion verification' group exists --name "$RESOURCE_GROUP")" == 'false' ]] || fail 'The dedicated resource group still exists.'
echo 'Uninstalled. Previously granted recording permissions remain unchanged.'
