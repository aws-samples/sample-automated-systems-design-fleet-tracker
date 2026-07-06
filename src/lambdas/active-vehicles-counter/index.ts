/**
 * Active Vehicles Counter Lambda
 *
 * Scans the vehicle-current-state DynamoDB table and emits a CloudWatch metric
 * (FleetTracking/ActiveVehicles) with the count of vehicles whose lastSeen
 * timestamp is within the configured stale threshold.
 *
 * Triggered on a 1-minute EventBridge schedule.
 */
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

const VEHICLE_STATE_TABLE = process.env.VEHICLE_STATE_TABLE!;
const STALE_THRESHOLD_MINUTES = parseInt(
  process.env.STALE_THRESHOLD_MINUTES || "5",
  10
);

const cloudWatch = new CloudWatchClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface VehicleStateRecord {
  vehicleId: string;
  lastSeen?: string; // ISO 8601 timestamp from GPS processor
}

/**
 * Counts vehicles whose lastSeen falls within the stale threshold.
 * Performs a paginated scan, projecting only vehicleId and lastSeen
 * to keep RCU usage minimal.
 */
async function countActiveVehicles(): Promise<number> {
  const cutoffMs = Date.now() - STALE_THRESHOLD_MINUTES * 60 * 1000;
  let activeCount = 0;
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await ddb.send(
      new ScanCommand({
        TableName: VEHICLE_STATE_TABLE,
        ProjectionExpression: "vehicleId, lastSeen",
        ExclusiveStartKey: lastEvaluatedKey as Record<string, unknown> | undefined,
      })
    );

    for (const item of (result.Items || []) as VehicleStateRecord[]) {
      if (!item.lastSeen) continue;
      const lastSeenMs = Date.parse(item.lastSeen);
      if (Number.isNaN(lastSeenMs)) continue;
      if (lastSeenMs >= cutoffMs) {
        activeCount += 1;
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (lastEvaluatedKey);

  return activeCount;
}

export async function handler(): Promise<void> {
  try {
    const activeCount = await countActiveVehicles();

    await cloudWatch.send(
      new PutMetricDataCommand({
        Namespace: "FleetTracking",
        MetricData: [
          {
            MetricName: "ActiveVehicles",
            Value: activeCount,
            Unit: "Count",
            Timestamp: new Date(),
          },
        ],
      })
    );

    console.log(
      JSON.stringify({
        level: "INFO",
        message: "Emitted ActiveVehicles metric",
        activeCount,
        staleThresholdMinutes: STALE_THRESHOLD_MINUTES,
      })
    );
  } catch (err) {
    console.log(
      JSON.stringify({
        level: "ERROR",
        message: "Failed to emit ActiveVehicles metric",
        error: err instanceof Error ? err.message : String(err),
      })
    );
    throw err;
  }
}
