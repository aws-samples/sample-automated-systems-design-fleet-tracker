#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { IoTStack } from "../lib/iot-stack";
import { IngestionStack } from "../lib/ingestion-stack";
import { LocationStack } from "../lib/location-stack";
import { ApiStack } from "../lib/api-stack";
import { HostingStack } from "../lib/hosting-stack";
import { MonitoringStack } from "../lib/monitoring-stack";
import { Phase2TablesStack } from "../lib/phase2-tables-stack";

const app = new cdk.App();

// Environment configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// CDK context for environment-specific configuration. Pass BOTH IPv4 and IPv6
// when possible — clients may reach CloudFront/API Gateway over either protocol,
// and IPv6 addresses rotate on macOS (privacy extensions), so populating both
// sets keeps the dashboard reachable across rotations.
//
// Usage:
//   IPV4=$(curl -4 -s ifconfig.me)
//   IPV6=$(curl -6 -s ifconfig.me)
//   cdk deploy --all --context deployerIpv4=$IPV4 --context deployerIpv6=$IPV6
//
// Legacy: --context deployerIp=<addr> still works; protocol is auto-detected.
const ctxIpv4 = app.node.tryGetContext("deployerIpv4") as string | undefined;
const ctxIpv6 = app.node.tryGetContext("deployerIpv6") as string | undefined;
const ctxLegacy = app.node.tryGetContext("deployerIp") as string | undefined;

const deployerIpv4 = ctxIpv4 ?? (ctxLegacy && !ctxLegacy.includes(":") ? ctxLegacy : undefined);
const deployerIpv6 = ctxIpv6 ?? (ctxLegacy && ctxLegacy.includes(":") ? ctxLegacy : undefined);

if (!deployerIpv4 && !deployerIpv6) {
  console.warn(
    "WARNING: No deployer IP set. Dashboard will be inaccessible.\n" +
    "Run: cdk deploy --all \\\n" +
    "  --context deployerIpv4=$(curl -4 -s ifconfig.me) \\\n" +
    "  --context deployerIpv6=$(curl -6 -s ifconfig.me)"
  );
}

/**
 * Stack Dependency Order:
 * IoTStack → IngestionStack → Phase2TablesStack → LocationStack → ApiStack → MonitoringStack → HostingStack
 *
 * Cross-stack references:
 * - IngestionStack exports: vehicleStateTable, dispatchTable, gpsHistoryTable, gpsStream, websocketConnectionsTable
 * - Phase2TablesStack exports: tenantsTable, emailSubscriptionsTable, analyticsDailyTable
 * - LocationStack exports: tracker, geofence collection resources, geofenceHandler Lambda, placeIndex, routeCalculator, map
 * - ApiStack exports: restApi, webSocketApi, userPool, identityPool
 * - MonitoringStack exports: opsTopic for alarm notifications; consumes ApiStack.webSocketApi for metrics
 * - HostingStack needs: API endpoints from ApiStack
 */

// 1. IoT Stack - Device provisioning, Thing Groups, Policies, Rules
const iotStack = new IoTStack(app, "FleetIoTStack", {
  env,
  description: "Fleet tracking IoT Core resources - Thing Groups, Policies, Rules",
});

// 2. Ingestion Stack - Kinesis, Lambda consumers, DynamoDB tables, IoT Rules
const ingestionStack = new IngestionStack(app, "FleetIngestionStack", {
  env,
  description: "Fleet tracking data ingestion - Kinesis, DynamoDB, Lambda processors, IoT Rules",
});
ingestionStack.addDependency(iotStack);

// 3. Phase 2 Tables Stack - New DynamoDB tables and GSIs for multi-tenant and analytics
const phase2TablesStack = new Phase2TablesStack(app, "FleetPhase2TablesStack", {
  env,
  vehicleStateTable: ingestionStack.vehicleStateTable,
  dispatchTable: ingestionStack.dispatchTable,
  websocketConnectionsTable: ingestionStack.websocketConnectionsTable,
  description: "Fleet tracking Phase 2 - Multi-tenant tables and analytics",
});
phase2TablesStack.addDependency(ingestionStack);

// 4. Location Stack - Tracker, Geofences, Maps, Routes, EventBridge rule for geofence events
const locationStack = new LocationStack(app, "FleetLocationStack", {
  env,
  dispatchTable: ingestionStack.dispatchTable,
  vehicleStateTable: ingestionStack.vehicleStateTable,
  connectionsTable: ingestionStack.websocketConnectionsTable,
  emailSubscriptionsTable: phase2TablesStack.emailSubscriptionsTable,
  description: "Fleet tracking Location Service - Tracker, Geofences, Maps, Routes, Geofence Handler",
});
locationStack.addDependency(ingestionStack);
locationStack.addDependency(phase2TablesStack);

// 5. API Stack - REST API, WebSocket API, Cognito, WAF, Lambdas
//    Created before MonitoringStack so its WebSocket API can be referenced for metrics.
const apiStack = new ApiStack(app, "FleetApiStack", {
  env,
  vehicleStateTable: ingestionStack.vehicleStateTable,
  dispatchTable: ingestionStack.dispatchTable,
  gpsHistoryTable: ingestionStack.gpsHistoryTable,
  websocketConnectionsTable: ingestionStack.websocketConnectionsTable,
  placeIndexName: locationStack.placeIndexName,
  routeCalculatorName: locationStack.routeCalculatorName,
  geofenceCollectionName: locationStack.geofenceCollectionName,
  mapName: locationStack.mapName,
  deployerIpv4,
  deployerIpv6,
  // Phase 2 tables
  emailSubscriptionsTable: phase2TablesStack.emailSubscriptionsTable,
  tenantsTable: phase2TablesStack.tenantsTable,
  analyticsDailyTable: phase2TablesStack.analyticsDailyTable,
  description: "Fleet tracking APIs - REST, WebSocket, Cognito, Tenant and Analytics Lambdas",
});
apiStack.addDependency(ingestionStack);
apiStack.addDependency(locationStack);
apiStack.addDependency(phase2TablesStack);

// 6. Monitoring Stack - CloudWatch dashboards, alarms, SNS topic
//    Receives the WebSocket API from ApiStack for connection metrics.
const monitoringStack = new MonitoringStack(app, "FleetMonitoringStack", {
  env,
  webSocketApi: apiStack.webSocketApi,
  description: "Fleet tracking monitoring - CloudWatch dashboards and alarms",
});
monitoringStack.addDependency(iotStack);
monitoringStack.addDependency(ingestionStack);
monitoringStack.addDependency(locationStack);
monitoringStack.addDependency(apiStack);

// 7. Hosting Stack - S3, CloudFront, WAF with IP allowlist
const hostingStack = new HostingStack(app, "FleetHostingStack", {
  env,
  deployerIpv4,
  deployerIpv6,
  restApiUrl: apiStack.restApi.url,
  webSocketUrl: `wss://${apiStack.webSocketApi.ref}.execute-api.${env.region}.amazonaws.com/v1`,
  userPoolId: apiStack.userPool.userPoolId,
  userPoolClientId: apiStack.userPoolClient.userPoolClientId,
  identityPoolId: apiStack.identityPool.ref,
  description: "Fleet tracking dashboard hosting - S3, CloudFront, WAF",
});
hostingStack.addDependency(apiStack);

// Add tags to all stacks for resource identification
cdk.Tags.of(app).add("Project", "FleetTracking");
cdk.Tags.of(app).add("Environment", "Demo");
