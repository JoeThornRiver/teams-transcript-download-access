targetScope = 'subscription'

@minLength(3)
@maxLength(12)
param deploymentName string

param location string

@minLength(3)
@maxLength(4)
param microsoftSearchRegion string

@secure()
param alertEmailAddress string

var suffix = substring(uniqueString(subscription().id, deploymentName), 0, 8)
var compactName = replace(deploymentName, '-', '')
var resourceGroupName = 'tra-${deploymentName}-rg'

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: {
    recordingAccessDeployment: deploymentName
  }
}

module tenant 'main.bicep' = {
  name: 'recording-access-resources'
  scope: resourceGroup
  params: {
    location: location
    functionAppName: 'tra-${deploymentName}-${suffix}'
    functionPlanName: 'tra-${deploymentName}-plan'
    managedIdentityName: 'tra-${deploymentName}-identity'
    storageAccountName: 'tra${compactName}${suffix}'
    logAnalyticsWorkspaceName: 'tra-${deploymentName}-logs'
    applicationInsightsName: 'tra-${deploymentName}-insights'
    microsoftSearchRegion: microsoftSearchRegion
    actionGroupName: 'tra-${deploymentName}-alerts'
    alertEmailAddress: alertEmailAddress
  }
}

output resourceGroupName string = resourceGroup.name
output functionAppName string = tenant.outputs.functionAppName
output managedIdentityPrincipalId string = tenant.outputs.managedIdentityPrincipalId
output actionGroupName string = tenant.outputs.actionGroupName
output storageAccountResourceId string = tenant.outputs.storageAccountResourceId
