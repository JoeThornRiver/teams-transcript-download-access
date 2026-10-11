#!/usr/bin/env bash

set -euo pipefail

REPOSITORY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GRAPH_APP_ID='00000003-0000-0000-c000-000000000000'
GRAPH_ROLE='Files.ReadWrite.All'

fail() { echo "$1" >&2; exit 1; }
confirm() { local answer; read -r -p "$1 [y/N]: " answer; [[ "$answer" == 'y' || "$answer" == 'Y' ]]; }
az_run() { local phase="$1"; shift; az "$@" 2>/dev/null || fail "${phase} failed."; }
az_value() { local phase="$1"; shift; local value; value="$(az "$@" 2>/dev/null)" || fail "${phase} failed."; printf '%s' "$value"; }

summarize_change_types() {
  local changes="$1" type change count summary=''
  for type in Create Delete Deploy Ignore Modify NoChange Unsupported; do
    count=0
    while IFS= read -r change; do [[ "$change" != "$type" ]] || count=$((count + 1)); done <<< "$changes"
    [[ "$count" == '0' ]] || summary="${summary}${summary:+, }${type}: ${count}"
  done
  printf '%s' "${summary:-No changes}"
}

ask_matching() {
  local __name="$1" prompt="$2" pattern="$3" error="$4" value
  while true; do
    read -r -p "${prompt}: " value || fail 'Input ended before all required values were supplied.'
    if [[ "$value" =~ $pattern ]]; then printf -v "$__name" '%s' "$value"; return; fi
    echo "$error" >&2
  done
}

ask_deployment_name() {
  ask_matching DEPLOYMENT_NAME 'Deployment name' '^[a-z][a-z0-9-]{2,11}$' 'Deployment name must be 3-12 lowercase letters, numbers, or hyphens and start with a letter.'
  set_names
}

ask_search_region() {
  ask_matching MICROSOFT_SEARCH_REGION 'Microsoft Search region' '^[A-Z]{3,4}$' 'Microsoft Search region must contain three or four uppercase letters.'
}

ask_alert_email() {
  ask_matching ALERT_EMAIL_ADDRESS 'Alert email address' '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' 'Alert email address is invalid.'
}

require_environment() {
  [[ "$(uname -s)" == 'Darwin' || "$(uname -s)" == 'Linux' ]] || fail 'Only macOS and Linux are supported.'
  (( BASH_VERSINFO[0] > 3 || (BASH_VERSINFO[0] == 3 && BASH_VERSINFO[1] >= 2) )) || fail 'Bash 3.2 or newer is required.'
  local command_name
  for command_name in az git node npm zip unzip; do
    command -v "$command_name" >/dev/null || fail "Missing required command: ${command_name}. Install it and rerun."
  done
  node -e 'if (Number(process.versions.node.split(".")[0]) < 20) process.exit(1)' || fail 'Node.js 20 or newer is required.'
  node -e 'const [a,b]=process.argv.slice(1).map(v=>v.match(/[0-9]+(\.[0-9]+)+/)[0].split(".").map(Number)); for(let i=0;i<Math.max(a.length,b.length);i++){if((a[i]||0)>(b[i]||0))process.exit(0);if((a[i]||0)<(b[i]||0))process.exit(1)}' "$(git --version)" '2.30.0' || fail 'Git 2.30 or newer is required.'
  node -e 'const [a,b]=process.argv.slice(1).map(v=>v.match(/[0-9]+(\.[0-9]+)+/)[0].split(".").map(Number)); for(let i=0;i<Math.max(a.length,b.length);i++){if((a[i]||0)>(b[i]||0))process.exit(0);if((a[i]||0)<(b[i]||0))process.exit(1)}' "$(az version --query '"azure-cli"' -o tsv)" '2.60.0' || fail 'Azure CLI 2.60 or newer is required.'
  az_run 'Bicep preflight' bicep version >/dev/null
  [[ "$(az_value 'Azure cloud preflight' cloud show --query name -o tsv)" == 'AzureCloud' ]] || fail 'Only the public Azure cloud is supported.'
  git -C "$REPOSITORY_ROOT" rev-parse --verify HEAD^{commit} >/dev/null || fail 'Run from a committed Git checkout.'
  git -C "$REPOSITORY_ROOT" diff --quiet && git -C "$REPOSITORY_ROOT" diff --cached --quiet || fail 'The Git checkout must be clean.'
  [[ -z "$(git -C "$REPOSITORY_ROOT" ls-files --others --exclude-standard)" ]] || fail 'The Git checkout contains untracked files.'
  RELEASE_REVISION="$(git -C "$REPOSITORY_ROOT" rev-parse --verify HEAD^{commit})"
}

select_subscription() {
  local subscription_output subscription choice index selected
  local subscriptions=()
  az account show >/dev/null 2>&1 || fail 'Run az login with an Azure resource administrator first.'
  subscription_output="$(az_value 'Subscription discovery' account list --query "[?state=='Enabled'].name" -o tsv)"
  [[ -n "$subscription_output" ]] || fail 'No enabled Azure subscription is available in the current tenant.'
  while IFS= read -r subscription; do subscriptions[${#subscriptions[@]}]="$subscription"; done <<< "$subscription_output"
  while true; do
    for ((index=0; index<${#subscriptions[@]}; index++)); do printf '%d) %s\n' "$((index + 1))" "${subscriptions[index]}"; done
    read -r -p 'Azure subscription number: ' choice || fail 'Input ended before all required values were supplied.'
    selected=''
    for ((index=0; index<${#subscriptions[@]}; index++)); do
      [[ "$choice" != "$((index + 1))" ]] || selected="${subscriptions[index]}"
    done
    if [[ -n "$selected" ]]; then AZURE_SUBSCRIPTION="$selected"; break; fi
    echo 'Choose a subscription number from the displayed list.' >&2
  done
  az_run 'Subscription selection' account set --subscription "$AZURE_SUBSCRIPTION"
  SUBSCRIPTION_NAME="$(az_value 'Subscription verification' account show --query name -o tsv)"
}

ask_azure_region() {
  local available region candidate found
  available="$(az_value 'Azure region discovery' account list-locations --query '[].name' -o tsv)"
  [[ -n "$available" ]] || fail 'No Azure regions are available for the selected subscription.'
  while true; do
    read -r -p 'Azure region: ' region || fail 'Input ended before all required values were supplied.'
    found='false'
    while IFS= read -r candidate; do [[ "$region" != "$candidate" ]] || found='true'; done <<< "$available"
    if [[ "$found" == 'true' ]]; then AZURE_REGION="$region"; return; fi
    echo 'Azure region must be one of the locations available to the selected subscription.' >&2
  done
}

set_names() {
  [[ "$DEPLOYMENT_NAME" =~ ^[a-z][a-z0-9-]{2,11}$ ]] || fail 'Deployment name must be 3-12 lowercase letters, numbers, or hyphens and start with a letter.'
  RESOURCE_GROUP="tra-${DEPLOYMENT_NAME}-rg"
  SUBSCRIPTION_DEPLOYMENT="tra-${DEPLOYMENT_NAME}"
}

read_output() {
  az_value 'Deployment output lookup' deployment sub show --name "$SUBSCRIPTION_DEPLOYMENT" --query "properties.outputs.$1.value" -o tsv
}

require_compatible_installation() {
  [[ "$(az_value 'Resource group ownership check' group show --name "$RESOURCE_GROUP" --query tags.recordingAccessDeployment -o tsv)" == "$DEPLOYMENT_NAME" ]] || fail 'The existing resource group is not owned by this deployment.'
  [[ "$(az_value 'Deployment ownership check' deployment sub show --name "$SUBSCRIPTION_DEPLOYMENT" --query properties.parameters.deploymentName.value -o tsv)" == "$DEPLOYMENT_NAME" ]] || fail 'The existing subscription deployment is incompatible.'
}

require_owned_inventory() {
  local actual expected entry
  EXPECTED_FUNCTION_APP=''
  EXPECTED_STORAGE_ACCOUNT=''
  actual="$(az_value 'Resource inventory check' resource list --resource-group "$RESOURCE_GROUP" --query '[].[type,name]' -o tsv)"
  [[ -n "$actual" ]] || return
  EXPECTED_FUNCTION_APP="$(az_value 'Deployment inventory check' deployment group show --resource-group "$RESOURCE_GROUP" --name recording-access-resources --query properties.parameters.functionAppName.value -o tsv)"
  EXPECTED_STORAGE_ACCOUNT="$(az_value 'Deployment inventory check' deployment group show --resource-group "$RESOURCE_GROUP" --name recording-access-resources --query properties.parameters.storageAccountName.value -o tsv)"
  expected="microsoft.web/serverfarms tra-${DEPLOYMENT_NAME}-plan
microsoft.web/sites ${EXPECTED_FUNCTION_APP}
microsoft.managedidentity/userassignedidentities tra-${DEPLOYMENT_NAME}-identity
microsoft.storage/storageaccounts ${EXPECTED_STORAGE_ACCOUNT}
microsoft.operationalinsights/workspaces tra-${DEPLOYMENT_NAME}-logs
microsoft.insights/components tra-${DEPLOYMENT_NAME}-insights
microsoft.insights/actiongroups tra-${DEPLOYMENT_NAME}-alerts
microsoft.insights/actiongroups Application Insights Smart Detection
microsoft.insights/scheduledqueryrules ${EXPECTED_FUNCTION_APP}-failures
microsoft.insights/scheduledqueryrules ${EXPECTED_FUNCTION_APP}-overdue"
  while IFS=$'\t' read -r resource_type resource_name; do
    resource_type="$(LC_ALL=C tr '[:upper:]' '[:lower:]' <<< "$resource_type")"
    entry="${resource_type} ${resource_name}"
    [[ $'\n'"$expected"$'\n' == *$'\n'"$entry"$'\n'* ]] || fail 'The resource group contains a resource not owned by this deployment.'
  done <<< "$actual"
}

login_graph_admin() {
  echo 'Authenticate the Microsoft Entra administrator. Exactly Files.ReadWrite.All will be managed.'
  az_run 'Entra administrator authentication' login --allow-no-subscriptions --output none
  GRAPH_SP_ID="$(az ad sp show --id "$GRAPH_APP_ID" --query id -o tsv 2>/dev/null)" || fail 'Microsoft Graph could not be resolved.'
  GRAPH_ROLE_ID="$(az ad sp show --id "$GRAPH_APP_ID" --query "appRoles[?value=='$GRAPH_ROLE' && contains(allowedMemberTypes, 'Application')].id | [0]" -o tsv 2>/dev/null)" || fail 'Files.ReadWrite.All could not be resolved.'
  [[ -n "$GRAPH_SP_ID" && -n "$GRAPH_ROLE_ID" ]] || fail 'Microsoft Graph or Files.ReadWrite.All could not be resolved.'
}

graph_assignment_count() {
  az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals/${MANAGED_IDENTITY_PRINCIPAL_ID}/appRoleAssignments?\$select=id,resourceId,appRoleId" --query "length(value[?resourceId=='$GRAPH_SP_ID'])" -o tsv 2>/dev/null || fail 'Microsoft Graph assignments could not be read.'
}

verify_graph_assignment() {
  [[ "$(graph_assignment_count)" == '1' ]] || fail 'The managed identity must have exactly one Microsoft Graph application role.'
  [[ "$(az rest --method get --url "https://graph.microsoft.com/v1.0/servicePrincipals/${MANAGED_IDENTITY_PRINCIPAL_ID}/appRoleAssignments?\$select=resourceId,appRoleId" --query "value[?resourceId=='$GRAPH_SP_ID'].appRoleId | [0]" -o tsv 2>/dev/null)" == "$GRAPH_ROLE_ID" ]] || fail 'The managed identity has an unexpected Microsoft Graph application role.'
}

restore_azure_admin() {
  echo 'Authenticate the Azure resource administrator to continue.'
  az_run 'Azure administrator authentication' login --output none
  az_run 'Subscription restoration' account set --subscription "$AZURE_SUBSCRIPTION"
}
