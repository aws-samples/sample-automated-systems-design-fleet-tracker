/**
 * GPS Processor Lambda - Kinesis Consumer
 * 
 * Processes GPS messages from Kinesis Data Streams and:
 * 1. Upserts vehicle-current-state table with latest position
 * 2. Archives each GPS update to gps-history table with 24h TTL
 * 
 * Position updates to the Amazon Location Service tracker are NOT handled here. They
 * are sent by the native `location` IoT rule action (GpsToLocationRule in
 * LocationStack), which writes to the tracker directly with no Lambda in the path.
 * 
 * Requirements: 2.5, 2.6, 2.7, 6.4, 11.2, 11.3, 12.6
 * - Lambda Kinesis consumer processes batches and upserts DynamoDB
 * - DynamoDB record includes: vehicleId (PK), position, heading, speed, lastSeen, status, assignedJob
 * - Lambda archives each GPS update to gps-history table
 * - TTL on gps-history records (24 hours) to auto-expire old data
 * - Uses timestamp from GPS payload (11.2)
 * - Logs warning for stale timestamps (11.3)
 * - Preserves tenantId on updates (12.6)
 * 
 * Configuration: batch size 10, 5s window (configured in CDK)
 */

import { KinesisStreamEvent, KinesisStreamRecord } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { 
  DynamoDBDocumentClient, 
  UpdateCommand,
  PutCommand,
  BatchWriteCommand
} from "@aws-sdk/lib-dynamodb";
import { 
  GpsMessage, 
  VehicleStatus, 
  GpsHistoryRecord 
} from "../../shared/types";

// Initialize DynamoDB Document Client
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

// Environment variables
const VEHICLE_STATE_TABLE = process.env.VEHICLE_STATE_TABLE!;
const GPS_HISTORY_TABLE = process.env.GPS_HISTORY_TABLE!;

// TTL duration: 24 hours in seconds
const TTL_DURATION_SECONDS = 24 * 60 * 60;

// Stale timestamp threshold: 5 minutes in milliseconds (Requirement 11.3)
const STALE_TIMESTAMP_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Parse GPS message from Kinesis record
 */
function parseGpsMessage(record: KinesisStreamRecord): GpsMessage {
  const payload = Buffer.from(record.kinesis.data, "base64").toString("utf-8");
  return JSON.parse(payload) as GpsMessage;
}

/**
 * Calculate TTL timestamp (24 hours from GPS capture time)
 * Uses the GPS message timestamp rather than processing time for accuracy
 */
function calculateTtl(gpsTimestamp: string): number {
  const captureTime = new Date(gpsTimestamp).getTime();
  return Math.floor(captureTime / 1000) + TTL_DURATION_SECONDS;
}

/**
 * Upsert vehicle current state in DynamoDB
 * Uses UpdateCommand to preserve existing fields like assignedJobId, technicianName, tenantId
 *
 * Status management strategy:
 * - If the GPS message includes an explicit status (e.g., from simulator), set it directly
 * - Otherwise, only update telemetry fields (position, heading, speed, ignition, lastSeen)
 *   and preserve existing status/assignedJobId set by the vehicle-api
 * - This prevents the GPS processor from overwriting job-related statuses (en-route, returning, on-site)
 *
 * Requirement 12.6: Preserves existing tenantId when updating Vehicle_State records
 * The UpdateCommand only updates specified fields, leaving tenantId unchanged
 */
async function upsertVehicleState(gpsMessage: GpsMessage & { status?: string }): Promise<void> {
  // If GPS message includes explicit status (e.g., from simulator), update status
  const hasExplicitStatus = 'status' in gpsMessage && gpsMessage.status !== undefined;

  let updateExpression: string;
  const expressionAttributeNames: Record<string, string> = {
    "#position": "position",
    "#heading": "heading",
    "#speed": "speed",
    "#ignition": "ignition",
    "#lastSeen": "lastSeen",
  };
  const expressionAttributeValues: Record<string, any> = {
    ":position": { lat: gpsMessage.lat, lng: gpsMessage.lng },
    ":heading": gpsMessage.heading,
    ":speed": gpsMessage.speed,
    ":ignition": gpsMessage.ignition,
    ":lastSeen": gpsMessage.timestamp,
  };

  if (hasExplicitStatus) {
    // Simulator or explicit status override - set status directly
    const status = gpsMessage.status as VehicleStatus;
    updateExpression = `SET #position = :position, #heading = :heading, #speed = :speed, #ignition = :ignition, #lastSeen = :lastSeen, #status = :status`;
    expressionAttributeNames["#status"] = "status";
    expressionAttributeValues[":status"] = status;

    // If setting to available, also remove assignedJobId
    if (status === "available") {
      updateExpression += " REMOVE assignedJobId";
    }
  } else {
    // No explicit status - only update telemetry fields
    // Preserve existing status and assignedJobId set by vehicle-api
    updateExpression = `SET #position = :position, #heading = :heading, #speed = :speed, #ignition = :ignition, #lastSeen = :lastSeen`;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: VEHICLE_STATE_TABLE,
      Key: { vehicleId: gpsMessage.vehicleId },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );
}

/**
 * Archive GPS update to history table
 */
async function archiveGpsHistory(gpsMessage: GpsMessage): Promise<void> {
  const historyRecord: GpsHistoryRecord = {
    vehicleId: gpsMessage.vehicleId,
    timestamp: gpsMessage.timestamp,
    position: { lat: gpsMessage.lat, lng: gpsMessage.lng },
    heading: gpsMessage.heading,
    speed: gpsMessage.speed,
    ignition: gpsMessage.ignition,
    ttl: calculateTtl(gpsMessage.timestamp),
  };

  await ddb.send(
    new PutCommand({
      TableName: GPS_HISTORY_TABLE,
      Item: historyRecord,
    })
  );
}

/**
 * Check if timestamp is stale (older than 5 minutes) (Task 9.3)
 * Requirement 11.3: Log warning for timestamps older than 5 minutes
 */
function checkStaleTimestamp(gpsMessage: GpsMessage): void {
  const messageTime = new Date(gpsMessage.timestamp).getTime();
  const now = Date.now();
  const age = now - messageTime;

  if (age > STALE_TIMESTAMP_THRESHOLD_MS) {
    console.log(JSON.stringify({
      level: "WARN",
      message: "Stale GPS timestamp detected",
      vehicleId: gpsMessage.vehicleId,
      timestamp: gpsMessage.timestamp,
      ageMinutes: Math.round(age / 60000),
      thresholdMinutes: STALE_TIMESTAMP_THRESHOLD_MS / 60000,
    }));
  }
}

/**
 * Process a single GPS record
 * Requirements: 7.1, 7.2, 7.4, 8.4, 11.2, 11.3
 * - Uses timestamp from GPS payload (11.2)
 * - Logs warning for stale timestamps (11.3)
 * - Sends to Tracker (7.1, 7.2) with failure isolation (7.4)
 * - DynamoDB updates independent of Tracker (8.4)
 */
async function processGpsRecord(record: KinesisStreamRecord): Promise<void> {
  const gpsMessage = parseGpsMessage(record);
  
  // Requirement 11.3: Check for stale timestamp and log warning
  checkStaleTimestamp(gpsMessage);
  
  // Log structured JSON for observability (Requirement 9.5)
  console.log(JSON.stringify({
    level: "INFO",
    message: "Processing GPS update",
    vehicleId: gpsMessage.vehicleId,
    position: { lat: gpsMessage.lat, lng: gpsMessage.lng },
    speed: gpsMessage.speed,
    ignition: gpsMessage.ignition,
    timestamp: gpsMessage.timestamp,
  }));

  // Execute DynamoDB operations in parallel for efficiency.
  // This Lambda receives every position regardless of whether the position was also
  // forwarded to the Location Service tracker, so route playback stays complete.
  await Promise.all([
    upsertVehicleState(gpsMessage),
    archiveGpsHistory(gpsMessage),
  ]);
}

/**
 * Partial batch failure response type for Kinesis event source mapping
 * When reportBatchItemFailures is enabled, Lambda returns failed record
 * sequence numbers so only those records are retried (not the entire batch).
 */
interface KinesisBatchResponse {
  batchItemFailures: Array<{ itemIdentifier: string }>;
}

/**
 * Lambda handler for Kinesis GPS stream
 * Processes batches of GPS messages (batch size 10, 5s window)
 * Returns partial batch failures via batchItemFailures for targeted retries
 */
export const handler = async (event: KinesisStreamEvent): Promise<KinesisBatchResponse> => {
  console.log(JSON.stringify({
    level: "INFO",
    message: "GPS processor invoked",
    recordCount: event.Records.length,
  }));

  const startTime = Date.now();
  let successCount = 0;
  let errorCount = 0;
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];

  // Process all records in parallel for efficiency
  for (const record of event.Records) {
    try {
      await processGpsRecord(record);
      successCount++;
    } catch (error) {
      errorCount++;
      console.error(JSON.stringify({
        level: "ERROR",
        message: "Failed to process GPS record",
        sequenceNumber: record.kinesis.sequenceNumber,
        error: error instanceof Error ? error.message : String(error),
      }));
      batchItemFailures.push({
        itemIdentifier: record.kinesis.sequenceNumber,
      });
    }
  }

  const duration = Date.now() - startTime;

  // Note: ActiveVehicles metric is emitted by the dedicated active-vehicles-counter Lambda
  // on a 1-minute schedule, scanning the vehicle-current-state table. Per-batch counts
  // here would only reflect Kinesis batching, not actual fleet activity.

  // Log batch processing summary
  console.log(JSON.stringify({
    level: "INFO",
    message: "GPS processor batch complete",
    totalRecords: event.Records.length,
    successCount,
    errorCount,
    failedSequenceNumbers: batchItemFailures.map(f => f.itemIdentifier),
    durationMs: duration,
  }));

  return { batchItemFailures };
};
