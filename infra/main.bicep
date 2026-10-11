@description('Azure region for every resource in this tenant-local deployment.')
@minLength(1)
param location string = resourceGroup().location

@description('Tenant-specific globally unique Function App name.')
@minLength(2)
@maxLength(60)
param functionAppName string

@description('Tenant-specific Flex Consumption plan name.')
@minLength(1)
@maxLength(40)
param functionPlanName string

@description('Tenant-specific user-assigned managed identity name.')
@minLength(3)
@maxLength(128)
param managedIdentityName string

@description('Tenant-specific globally unique storage account name.')
@minLength(3)
@maxLength(24)
param storageAccountName string

@description('Tenant-specific Log Analytics workspace name.')
@minLength(4)
@maxLength(63)
param logAnalyticsWorkspaceName string

@description('Tenant-specific Application Insights component name.')
@minLength(1)
@maxLength(260)
param applicationInsightsName string

@description('Microsoft Search region configured for this tenant, for example DEU or EMEA.')
@minLength(3)
@maxLength(4)
param microsoftSearchRegion string

@description('Six-field Azure Functions NCRONTAB schedule.')
@minLength(1)
param timerSchedule string = '0 */5 * * * *'

@description('Maximum discovery catch-up window in days.')
@minValue(1)
param maxLookbackDays int = 14

@description('Overlap used to tolerate Microsoft Search indexing delay.')
@minValue(1)
param searchIndexOverlapMinutes int = 30

@description('Microsoft Search page size.')
@minValue(1)
@maxValue(1000)
param searchPageSize int = 100

@description('Dedicated Azure Monitor Action Group name.')
@minLength(1)
param actionGroupName string

@description('Email address for the dedicated alert receiver.')
@secure()
param alertEmailAddress string

var deploymentContainerName = 'app-package'
var watermarkContainerName = 'state'
var storageBlobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var monitoringMetricsPublisherRoleId = '3913510d-42f4-4e42-8a64-420c390055eb'

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsWorkspaceName
  location: location
  properties: {
    retentionInDays: 30
    features: {
      searchVersion: 1
    }
    sku: {
      name: 'PerGB2018'
    }
  }
}

resource applicationInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: applicationInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    DisableLocalAuth: true
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
  }
  resource blobService 'blobServices' = {
    name: 'default'
    properties: {
      deleteRetentionPolicy: {
        enabled: true
        days: 7
      }
    }
    resource deploymentContainer 'containers' = {
      name: deploymentContainerName
      properties: {
        publicAccess: 'None'
      }
    }
    resource watermarkContainer 'containers' = {
      name: watermarkContainerName
      properties: {
        publicAccess: 'None'
      }
    }
  }
}

resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: managedIdentityName
  location: location
}

resource actionGroup 'Microsoft.Insights/actionGroups@2021-09-01' = {
  name: actionGroupName
  location: 'Global'
  properties: {
    enabled: true
    groupShortName: 'recording'
    emailReceivers: [
      {
        name: 'operator'
        emailAddress: alertEmailAddress
        useCommonAlertSchema: true
      }
    ]
  }
}

resource blobDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, managedIdentity.id, storageBlobDataOwnerRoleId)
  scope: storage
  properties: {
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataOwnerRoleId)
  }
}

resource metricsPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(applicationInsights.id, managedIdentity.id, monitoringMetricsPublisherRoleId)
  scope: applicationInsights
  properties: {
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringMetricsPublisherRoleId)
  }
}

resource functionPlan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: functionPlanName
  location: location
  kind: 'functionapp'
  sku: {
    name: 'FC1'
    tier: 'FlexConsumption'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2024-04-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: functionPlan.id
    httpsOnly: true
    siteConfig: {
      minTlsVersion: '1.2'
    }
    functionAppConfig: {
      deployment: {
        storage: {
          type: 'blobContainer'
          value: '${storage.properties.primaryEndpoints.blob}${deploymentContainerName}'
          authentication: {
            type: 'UserAssignedIdentity'
            userAssignedIdentityResourceId: managedIdentity.id
          }
        }
      }
      runtime: {
        name: 'node'
        version: '22'
      }
      scaleAndConcurrency: {
        maximumInstanceCount: 100
        instanceMemoryMB: 2048
      }
    }
  }
  dependsOn: [
    storage::blobService::deploymentContainer
    blobDataOwner
  ]
  resource appSettings 'config' = {
    name: 'appsettings'
    properties: {
      FUNCTIONS_EXTENSION_VERSION: '~4'
      AzureWebJobsStorage__accountName: storage.name
      AzureWebJobsStorage__credential: 'managedidentity'
      AzureWebJobsStorage__clientId: managedIdentity.properties.clientId
      APPLICATIONINSIGHTS_CONNECTION_STRING: applicationInsights.properties.ConnectionString
      APPLICATIONINSIGHTS_AUTHENTICATION_STRING: 'ClientId=${managedIdentity.properties.clientId};Authorization=AAD'
      AZURE_CLIENT_ID: managedIdentity.properties.clientId
      WATERMARK_STORAGE_ACCOUNT_URL: storage.properties.primaryEndpoints.blob
      MICROSOFT_SEARCH_REGION: microsoftSearchRegion
      CANARY_TIMER_SCHEDULE: timerSchedule
      MAX_LOOKBACK_DAYS: string(maxLookbackDays)
      SEARCH_INDEX_OVERLAP_MINUTES: string(searchIndexOverlapMinutes)
      SEARCH_PAGE_SIZE: string(searchPageSize)
    }
  }
}

resource failureAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${functionAppName}-failures'
  location: location
  kind: 'LogAlert'
  properties: {
    actions: {
      actionGroups: [actionGroup.id]
    }
    autoMitigate: true
    criteria: {
      allOf: [
        {
          operator: 'GreaterThan'
          query: 'traces | where tostring(parse_json(message).event) in ("canary-run-failed", "canary-invocation-failed")'
          threshold: 0
          timeAggregation: 'Count'
        }
      ]
    }
    description: 'Alerts on Search, authorization, malformed Graph response, watermark, and timer execution failures.'
    displayName: '${functionAppName} discovery failures'
    enabled: true
    evaluationFrequency: 'PT5M'
    scopes: [applicationInsights.id]
    severity: 1
    windowSize: 'PT5M'
  }
}

resource overdueTimerAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${functionAppName}-overdue'
  location: location
  kind: 'LogAlert'
  properties: {
    actions: {
      actionGroups: [actionGroup.id]
    }
    autoMitigate: true
    criteria: {
      allOf: [
        {
          operator: 'LessThan'
          query: 'traces | where tostring(parse_json(message).event) == "canary-run-succeeded"'
          threshold: 1
          timeAggregation: 'Count'
        }
      ]
    }
    description: 'Alerts when no successful monitored timer execution is observed during the evaluation window.'
    displayName: '${functionAppName} overdue timer'
    enabled: true
    evaluationFrequency: 'PT5M'
    scopes: [applicationInsights.id]
    severity: 1
    windowSize: 'PT15M'
  }
}

output functionAppName string = functionApp.name
output managedIdentityPrincipalId string = managedIdentity.properties.principalId
output managedIdentityClientId string = managedIdentity.properties.clientId
output actionGroupName string = actionGroup.name
output storageAccountResourceId string = storage.id
output watermarkBlobPath string = '${watermarkContainerName}/last-successful-run.json'
