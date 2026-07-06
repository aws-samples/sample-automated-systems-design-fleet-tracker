import * as cdk from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Construct } from "constructs";

/**
 * Props for Phase2TablesStack
 * Accepts existing tables to add GSIs
 */
export interface Phase2TablesStackProps extends cdk.StackProps {
  /** Existing vehicle state table to add GSI */
  vehicleStateTable: dynamodb.Table;
  /** Existing dispatch assignments table to add GSI */
  dispatchTable: dynamodb.Table;
  /** Existing websocket connections table to add GSI */
  websocketConnectionsTable: dynamodb.Table;
}

/**
 * Phase 2 Infrastructure: New DynamoDB Tables and GSIs
 * 
 * New Tables:
 * - tenants: Multi-tenant organization data
 * - email-subscriptions: Email notification subscriptions per tenant
 * - analytics-daily: Pre-aggregated daily metrics
 * 
 * GSI Additions:
 * - vehicle-current-state: tenantId-index for tenant-scoped queries
 * - dispatch-assignments: tenantId-createdAt-index for tenant-scoped job queries
 * - websocket-connections: tenantId-index for tenant-filtered broadcasts
 */
export class Phase2TablesStack extends cdk.Stack {
  public readonly tenantsTable: dynamodb.Table;
  public readonly emailSubscriptionsTable: dynamodb.Table;
  public readonly analyticsDailyTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: Phase2TablesStackProps) {
    super(scope, id, props);

    const {
      vehicleStateTable,
      dispatchTable,
      websocketConnectionsTable,
    } = props;

    // =========================================================================
    // Task 1.1: Create tenants DynamoDB table
    // Requirements: 14.1, 14.2, 14.3
    // =========================================================================
    this.tenantsTable = new dynamodb.Table(this, "TenantsTable", {
      tableName: "tenants",
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Demo only
    });

    // =========================================================================
    // Task 1.2: Create email-subscriptions DynamoDB table
    // Requirements: 3.7
    // =========================================================================
    this.emailSubscriptionsTable = new dynamodb.Table(this, "EmailSubscriptionsTable", {
      tableName: "email-subscriptions",
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "email", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Demo only
    });

    // =========================================================================
    // Task 1.3: Create analytics-daily DynamoDB table
    // Requirements: 19.3
    // =========================================================================
    this.analyticsDailyTable = new dynamodb.Table(this, "AnalyticsDailyTable", {
      tableName: "analytics-daily",
      partitionKey: { name: "tenantIdDate", type: dynamodb.AttributeType.STRING }, // Format: {tenantId}#{date}
      sortKey: { name: "metricType", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Demo only
    });

    // =========================================================================
    // Task 1.5: Add GSIs to existing tables
    // Requirements: 12.1, 12.2, 12.3, 13.5
    // =========================================================================

    // GSI on vehicle-current-state for tenant-scoped queries
    vehicleStateTable.addGlobalSecondaryIndex({
      indexName: "tenantId-index",
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI on dispatch-assignments for tenant-scoped job queries with date sorting
    dispatchTable.addGlobalSecondaryIndex({
      indexName: "tenantId-createdAt-index",
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "createdAt", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI on websocket-connections for tenant-filtered broadcasts
    websocketConnectionsTable.addGlobalSecondaryIndex({
      indexName: "tenantId-index",
      partitionKey: { name: "tenantId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // =========================================================================
    // Outputs
    // =========================================================================
    new cdk.CfnOutput(this, "TenantsTableName", {
      value: this.tenantsTable.tableName,
      description: "Tenants DynamoDB table name",
    });

    new cdk.CfnOutput(this, "EmailSubscriptionsTableName", {
      value: this.emailSubscriptionsTable.tableName,
      description: "Email subscriptions DynamoDB table name",
    });

    new cdk.CfnOutput(this, "AnalyticsDailyTableName", {
      value: this.analyticsDailyTable.tableName,
      description: "Analytics daily DynamoDB table name",
    });
  }
}
