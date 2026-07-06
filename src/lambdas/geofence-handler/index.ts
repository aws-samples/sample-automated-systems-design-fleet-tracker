/**
 * Geofence Handler Lambda
 * Processes geofence ENTER events from Amazon Location Service via EventBridge
 * 
 * Phase 2 Requirements:
 * - 1.1-1.5: Job completion flow (update dispatch, delete geofence)
 * - 2.2-2.5: Vehicle status lifecycle (available → en-route → returning → available)
 * - 3.1-3.2: SQS notification publishing for job completion
 * - 4.4-4.6: Home base return detection
 * - 6.1-6.5: Structured logging and CloudWatch metrics
 */

import { EventBridgeEvent, Context } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { LocationClient, BatchDeleteGeofenceCommand } from "@aws-sdk/client-location";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { JobCompletedMessage, WebSocketMessage, VehicleStatus } from "../../shared/types";

// Environment variables
const DISPATCH_TABLE = process.env.DISPATCH_TABLE!;
const VEHICLE_STATE_TABLE = process.env.VEHICLE_STATE_TABLE!;
const GEOFENCE_COLLECTION_NAME = process.env.GEOFENCE_COLLECTION_NAME!;
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT;
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE;
const JOB_COMPLETION_TOPIC_ARN = process.env.JOB_COMPLETION_TOPIC_ARN;

// AWS SDK clients
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const locationClient = new LocationClient({});
const snsClient = new SNSClient({});
const cloudWatchClient = new CloudWatchClient({});

interface LocationGeofenceEventDetail {
  EventType: "ENTER" | "EXIT";
  GeofenceId: string;
  DeviceId: string;
  Position: [number, number];
  SampleTime: string;
  GeofenceCollection: string;
}

interface LogData {
  level: "INFO" | "ERROR" | "WARN";
  message: string;
  timestamp: string;
  requestId?: string;
  eventType?: string;
  geofenceId?: string;
  vehicleId?: string;
  jobId?: string;
  position?: { lat: number; lng: number };
  sampleTime?: string;
  completedAt?: string;
  status?: string;
  errorName?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

// Structured logging (Requirement 6.1-6.4)
function log(level: "INFO" | "ERROR" | "WARN", message: string, data?: Partial<LogData>): void {
  const logEntry: LogData = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...data,
  };
  console.log(JSON.stringify(logEntry));
}

// Valid vehicle status transitions (Requirement 2.5)
const VALID_TRANSITIONS: Record<VehicleStatus, VehicleStatus[]> = {
  'available': ['en-route'],
  'en-route': ['returning', 'on-site'],
  'on-site': ['returning'],
  'returning': ['available'],
  'offline': ['available'],
  'idle': ['available', 'en-route'],
};

function isValidTransition(from: VehicleStatus, to: VehicleStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

function extractJobId(geofenceId: string): string | null {
  const prefix = "job-";
  return geofenceId.startsWith(prefix) ? geofenceId.substring(prefix.length) : null;
}

function isHomeBaseGeofence(geofenceId: string): boolean {
  return geofenceId.startsWith("home-");
}

function extractVehicleIdFromHomeBase(geofenceId: string): string | null {
  const prefix = "home-";
  return geofenceId.startsWith(prefix) ? geofenceId.substring(prefix.length) : null;
}

async function getVehicleState(vehicleId: string): Promise<{ status: VehicleStatus; tenantId?: string; assignedJobId?: string } | null> {
  const result = await ddb.send(new GetCommand({
    TableName: VEHICLE_STATE_TABLE,
    Key: { vehicleId },
    ProjectionExpression: "#status, tenantId, assignedJobId",
    ExpressionAttributeNames: { "#status": "status" },
  }));
  return result.Item as { status: VehicleStatus; tenantId?: string; assignedJobId?: string } | null;
}

async function getDispatchAssignment(jobId: string, vehicleId: string): Promise<{ status: string; tenantId?: string; address?: string } | null> {
  const result = await ddb.send(new GetCommand({
    TableName: DISPATCH_TABLE,
    Key: { jobId, vehicleId },
    ProjectionExpression: "#status, tenantId, address",
    ExpressionAttributeNames: { "#status": "status" },
  }));
  return result.Item as { status: string; tenantId?: string; address?: string } | null;
}

// Requirement 1.1, 1.2: Update dispatch assignment to completed
async function updateDispatchAssignment(jobId: string, vehicleId: string, completedAt: string): Promise<void> {
  log("INFO", "Updating dispatch assignment to completed", { jobId, vehicleId });
  try {
    await ddb.send(new UpdateCommand({
      TableName: DISPATCH_TABLE,
      Key: { jobId, vehicleId },
      UpdateExpression: "SET #status = :status, completedAt = :completedAt",
      ExpressionAttributeNames: { "#status": "status", "#currentStatus": "status" },
      ExpressionAttributeValues: { ":status": "completed", ":completedAt": completedAt, ":completed": "completed" },
      ConditionExpression: "attribute_exists(jobId) AND #currentStatus <> :completed",
    }));
    log("INFO", "Dispatch assignment updated successfully", { jobId, vehicleId, status: "completed", completedAt });
  } catch (error: unknown) {
    const err = error as { name?: string };
    if (err.name === "ConditionalCheckFailedException") {
      // Requirement 1.4: Handle non-existent or already-completed job gracefully
      log("WARN", "Job does not exist or was already completed, skipping update", { jobId, vehicleId });
      return;
    }
    throw error;
  }
}

// Requirement 2.2, 2.3: Update vehicle status to returning on job completion
async function updateVehicleStatusToReturning(vehicleId: string): Promise<void> {
  log("INFO", "Updating vehicle state to returning", { vehicleId });
  await ddb.send(new UpdateCommand({
    TableName: VEHICLE_STATE_TABLE,
    Key: { vehicleId },
    UpdateExpression: "SET #status = :status REMOVE assignedJobId",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":status": "returning" },
  }));
  log("INFO", "Vehicle state updated successfully", { vehicleId, status: "returning" });
}

// Requirement 4.4: Update vehicle status to available on home base return
async function updateVehicleStatusToAvailable(vehicleId: string): Promise<void> {
  log("INFO", "Updating vehicle state to available", { vehicleId });
  await ddb.send(new UpdateCommand({
    TableName: VEHICLE_STATE_TABLE,
    Key: { vehicleId },
    UpdateExpression: "SET #status = :status",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":status": "available" },
  }));
  log("INFO", "Vehicle state updated successfully", { vehicleId, status: "available" });
}

// Requirement 1.3: Delete job geofence after completion (one-time use)
async function deleteGeofence(geofenceId: string): Promise<void> {
  log("INFO", "Deleting geofence", { geofenceId, collectionName: GEOFENCE_COLLECTION_NAME });
  await locationClient.send(new BatchDeleteGeofenceCommand({
    CollectionName: GEOFENCE_COLLECTION_NAME,
    GeofenceIds: [geofenceId],
  }));
  log("INFO", "Geofence deleted successfully", { geofenceId });
}

// Requirement 3.1, 3.2: Publish job completion notification to SNS
async function publishJobCompletionNotification(
  jobId: string,
  vehicleId: string,
  completedAt: string,
  destination: string,
  tenantId?: string
): Promise<void> {
  if (!JOB_COMPLETION_TOPIC_ARN) {
    log("WARN", "Job completion topic not configured, skipping SNS publish");
    return;
  }

  const message = {
    type: "JOB_COMPLETED",
    jobId,
    vehicleId,
    completedAt,
    destination,
    tenantId: tenantId || "default",
  };

  log("INFO", "Publishing job completion notification to SNS", { jobId, vehicleId, tenantId });
  await snsClient.send(new PublishCommand({
    TopicArn: JOB_COMPLETION_TOPIC_ARN,
    Message: JSON.stringify(message),
    MessageAttributes: {
      eventType: { DataType: "String", StringValue: "JOB_COMPLETED" },
      tenantId: { DataType: "String", StringValue: tenantId || "default" },
    },
  }));
  log("INFO", "Job completion notification published successfully", { jobId, vehicleId });
}

// Requirement 6.5: Emit CloudWatch metric for job completion
async function emitJobCompletionMetric(vehicleId: string, tenantId?: string): Promise<void> {
  try {
    await cloudWatchClient.send(new PutMetricDataCommand({
      Namespace: "FleetTracking",
      MetricData: [
        // Metric with dimensions for detailed analysis
        {
          MetricName: "JobsCompleted",
          Value: 1,
          Unit: "Count",
          Dimensions: [
            { Name: "VehicleId", Value: vehicleId },
            { Name: "TenantId", Value: tenantId || "default" },
          ],
        },
        // Metric without dimensions for dashboard aggregate
        {
          MetricName: "JobsCompleted",
          Value: 1,
          Unit: "Count",
        },
      ],
    }));
    log("INFO", "Job completion metric emitted", { vehicleId, tenantId });
  } catch (error: unknown) {
    const err = error as { message?: string };
    log("WARN", "Failed to emit CloudWatch metric", { errorMessage: err.message });
    // Don't throw - metrics are non-critical
  }
}

async function broadcastJobCompletion(jobId: string, vehicleId: string, completedAt: string): Promise<void> {
  if (!WEBSOCKET_ENDPOINT || !CONNECTIONS_TABLE) {
    log("WARN", "WebSocket broadcast skipped - endpoint or connections table not configured");
    return;
  }
  log("INFO", "Broadcasting job completion", { jobId, vehicleId });
  const apiGateway = new ApiGatewayManagementApiClient({ endpoint: WEBSOCKET_ENDPOINT });
  const connectionsResult = await ddb.send(new ScanCommand({
    TableName: CONNECTIONS_TABLE,
    ProjectionExpression: "connectionId",
  }));
  const connections = connectionsResult.Items || [];
  if (connections.length === 0) {
    log("INFO", "No active WebSocket connections to broadcast to");
    return;
  }
  const message: WebSocketMessage<JobCompletedMessage> = {
    type: "JOB_COMPLETED",
    data: { jobId, vehicleId, completedAt },
    timestamp: completedAt,
  };
  const messagePayload = JSON.stringify(message);
  const broadcastPromises = connections.map(async (connection) => {
    const connectionId = connection.connectionId as string;
    try {
      await apiGateway.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(messagePayload),
      }));
      log("INFO", "Message sent to connection", { connectionId });
    } catch (error: unknown) {
      const err = error as { statusCode?: number; message?: string };
      if (err.statusCode === 410) {
        log("WARN", "Stale connection detected", { connectionId });
      } else {
        log("ERROR", "Failed to send message to connection", { connectionId, errorMessage: err.message });
      }
    }
  });
  await Promise.all(broadcastPromises);
  log("INFO", "Job completion broadcast completed", { jobId, connectionCount: connections.length });
}

// Handle job geofence ENTER event (Requirement 1.1-1.5, 2.2-2.4)
async function handleJobCompletion(
  jobId: string,
  vehicleId: string,
  geofenceId: string,
  completedAt: string,
  requestId: string
): Promise<void> {
  // Get dispatch assignment to check if it exists and get tenantId
  const assignment = await getDispatchAssignment(jobId, vehicleId);
  if (!assignment) {
    log("WARN", "Job does not exist, ignoring geofence event", { jobId, vehicleId, requestId });
    return;
  }

  // Get current vehicle state to validate transition
  const vehicleState = await getVehicleState(vehicleId);
  if (vehicleState && !isValidTransition(vehicleState.status, 'returning')) {
    log("WARN", "Invalid status transition, vehicle not in expected state", {
      vehicleId,
      currentStatus: vehicleState.status,
      targetStatus: "returning",
      requestId,
    });
    // Continue anyway for job completion - the job is done regardless of vehicle state
  }

  // Update dispatch assignment to completed
  await updateDispatchAssignment(jobId, vehicleId, completedAt);

  // Update vehicle status to returning (Requirement 2.2, 2.3)
  await updateVehicleStatusToReturning(vehicleId);

  // Delete job geofence (Requirement 1.3)
  await deleteGeofence(geofenceId);

  // Publish notification to SQS (Requirement 3.1, 3.2)
  await publishJobCompletionNotification(
    jobId,
    vehicleId,
    completedAt,
    assignment.address || "Unknown",
    assignment.tenantId || vehicleState?.tenantId
  );

  // Emit CloudWatch metric (Requirement 6.5)
  await emitJobCompletionMetric(vehicleId, assignment.tenantId || vehicleState?.tenantId);

  // Broadcast to WebSocket clients
  await broadcastJobCompletion(jobId, vehicleId, completedAt);

  log("INFO", "Job completion processed successfully", {
    requestId,
    jobId,
    vehicleId,
    completedAt,
  });
}

// Handle home base geofence ENTER event (Requirement 4.4-4.6)
async function handleHomeBaseReturn(
  vehicleId: string,
  geofenceId: string,
  requestId: string
): Promise<void> {
  // Get current vehicle state
  const vehicleState = await getVehicleState(vehicleId);
  if (!vehicleState) {
    log("WARN", "Vehicle state not found", { vehicleId, requestId });
    return;
  }

  // Requirement 4.6: Only update to available if current status is "returning"
  if (vehicleState.status !== "returning") {
    log("INFO", "Ignoring home base entry - vehicle not in returning status", {
      vehicleId,
      currentStatus: vehicleState.status,
      requestId,
    });
    return;
  }

  // Validate transition (Requirement 2.5)
  if (!isValidTransition(vehicleState.status, 'available')) {
    log("WARN", "Invalid status transition from returning to available", {
      vehicleId,
      currentStatus: vehicleState.status,
      requestId,
    });
    return;
  }

  // Update vehicle status to available (Requirement 4.4)
  await updateVehicleStatusToAvailable(vehicleId);

  // Requirement 4.5: Do NOT delete home base geofence (persistent)
  log("INFO", "Home base return processed successfully - geofence preserved", {
    requestId,
    vehicleId,
    geofenceId,
  });
}

export const handler = async (
  event: EventBridgeEvent<"Location Geofence Event", LocationGeofenceEventDetail>,
  context: Context
): Promise<void> => {
  const { EventType, GeofenceId, DeviceId, Position, SampleTime } = event.detail;
  const vehicleId = DeviceId;
  const requestId = context.awsRequestId;

  // Requirement 6.1: Log all events with structured format
  log("INFO", "Received geofence event", {
    requestId,
    eventType: EventType,
    geofenceId: GeofenceId,
    vehicleId,
    position: { lng: Position[0], lat: Position[1] },
    sampleTime: SampleTime,
  });

  // Only process ENTER events
  if (EventType !== "ENTER") {
    log("INFO", "Ignoring non-ENTER event", { eventType: EventType, requestId });
    return;
  }

  const completedAt = new Date().toISOString();

  try {
    // Check if this is a home base geofence (Requirement 4.4-4.6)
    if (isHomeBaseGeofence(GeofenceId)) {
      const homeVehicleId = extractVehicleIdFromHomeBase(GeofenceId);
      if (homeVehicleId && homeVehicleId === vehicleId) {
        await handleHomeBaseReturn(vehicleId, GeofenceId, requestId);
      } else {
        log("WARN", "Home base geofence vehicle mismatch", {
          geofenceId: GeofenceId,
          expectedVehicleId: homeVehicleId,
          actualVehicleId: vehicleId,
          requestId,
        });
      }
      return;
    }

    // Check if this is a job geofence (Requirement 1.1-1.5)
    const jobId = extractJobId(GeofenceId);
    if (jobId) {
      await handleJobCompletion(jobId, vehicleId, GeofenceId, completedAt, requestId);
      return;
    }

    // Unknown geofence type
    log("WARN", "Unknown geofence type", { geofenceId: GeofenceId, requestId });
  } catch (error: unknown) {
    const err = error as { name?: string; message?: string };
    // Requirement 6.4: Log errors with full context
    log("ERROR", "Failed to process geofence event", {
      requestId,
      geofenceId: GeofenceId,
      vehicleId,
      errorName: err.name,
      errorMessage: err.message,
    });
    throw error;
  }
};
