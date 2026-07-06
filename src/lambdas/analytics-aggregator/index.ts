/**
 * Analytics Aggregator Lambda Handler
 * 
 * Task 20: Daily aggregation of analytics metrics
 * Requirements: 19.1-19.6
 * 
 * Triggered by EventBridge scheduled rule at midnight UTC.
 * Processes completed jobs from previous day and calculates:
 * - Job metrics (total, completed, duration)
 * - Vehicle utilization (active vs idle time)
 * - Route efficiency (planned vs actual distance)
 */

import { ScheduledHandler, Context } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const cloudWatchClient = new CloudWatchClient({});

const DISPATCH_TABLE = process.env.DISPATCH_TABLE!;
const VEHICLE_STATE_TABLE = process.env.VEHICLE_STATE_TABLE!;
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE!;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

interface JobMetrics {
  totalJobs: number;
  completedJobs: number;
  totalDurationMinutes: number;
}

interface UtilizationMetrics {
  activeMinutes: number;
  idleMinutes: number;
}

interface RouteMetrics {
  plannedDistanceKm: number;
  actualDistanceKm: number;
  flaggedCount: number;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      console.warn(`Attempt ${attempt + 1} failed:`, error);
      if (attempt < retries - 1) {
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

export const handler: ScheduledHandler = async (event, context: Context): Promise<void> => {
  const startTime = Date.now();
  console.log("Analytics aggregation started", { requestId: context.awsRequestId });

  // Calculate date range for previous day
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  yesterday.setUTCHours(0, 0, 0, 0);
  
  const endOfYesterday = new Date(yesterday);
  endOfYesterday.setUTCHours(23, 59, 59, 999);

  const dateStr = yesterday.toISOString().split("T")[0];
  console.log("Processing date:", dateStr);

  try {
    // Fetch completed jobs from previous day
    const jobs = await fetchCompletedJobs(yesterday.toISOString(), endOfYesterday.toISOString());
    console.log(`Found ${jobs.length} completed jobs`);

    // Fetch vehicle states for utilization calculation
    const vehicles = await fetchVehicleStates();
    console.log(`Found ${vehicles.length} vehicles`);

    // Group jobs by tenant
    const jobsByTenant = groupByTenant(jobs);
    const vehiclesByTenant = groupByTenant(vehicles);

    let totalJobsProcessed = 0;

    // Process each tenant
    for (const [tenantId, tenantJobs] of Object.entries(jobsByTenant)) {
      const tenantVehicles = vehiclesByTenant[tenantId] || [];
      
      // Calculate job metrics
      const jobMetrics = calculateJobMetrics(tenantJobs);
      await storeMetrics(tenantId, dateStr, "jobs", jobMetrics);

      // Calculate utilization metrics per vehicle
      for (const vehicle of tenantVehicles) {
        const vehicleJobs = tenantJobs.filter((j: any) => j.vehicleId === vehicle.vehicleId);
        const utilizationMetrics = calculateUtilizationMetrics(vehicleJobs);
        await storeMetrics(tenantId, dateStr, "utilization", {
          ...utilizationMetrics,
          vehicleId: vehicle.vehicleId,
        });
      }

      // Calculate route efficiency metrics
      const routeMetrics = calculateRouteMetrics(tenantJobs);
      await storeMetrics(tenantId, dateStr, "routes", routeMetrics);

      totalJobsProcessed += tenantJobs.length;
    }

    const duration = Date.now() - startTime;
    console.log("Analytics aggregation completed", { 
      jobsProcessed: totalJobsProcessed, 
      durationMs: duration 
    });

    // Emit CloudWatch metrics
    await emitMetrics(totalJobsProcessed, duration);

  } catch (error) {
    console.error("Analytics aggregation failed:", error);
    throw error;
  }
};

async function fetchCompletedJobs(startTime: string, endTime: string): Promise<any[]> {
  return withRetry(async () => {
    const result = await docClient.send(
      new ScanCommand({
        TableName: DISPATCH_TABLE,
        FilterExpression: "#status = :completed AND completedAt BETWEEN :start AND :end",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":completed": "completed",
          ":start": startTime,
          ":end": endTime,
        },
      })
    );
    return result.Items || [];
  });
}

async function fetchVehicleStates(): Promise<any[]> {
  return withRetry(async () => {
    const result = await docClient.send(
      new ScanCommand({
        TableName: VEHICLE_STATE_TABLE,
      })
    );
    return result.Items || [];
  });
}

function groupByTenant(items: any[]): Record<string, any[]> {
  return items.reduce((acc, item) => {
    const tenantId = item.tenantId || "default";
    if (!acc[tenantId]) {
      acc[tenantId] = [];
    }
    acc[tenantId].push(item);
    return acc;
  }, {} as Record<string, any[]>);
}

function calculateJobMetrics(jobs: any[]): JobMetrics {
  let totalDurationMinutes = 0;
  
  for (const job of jobs) {
    if (job.createdAt && job.completedAt) {
      const created = new Date(job.createdAt).getTime();
      const completed = new Date(job.completedAt).getTime();
      const durationMs = completed - created;
      totalDurationMinutes += durationMs / (1000 * 60);
    }
  }

  return {
    totalJobs: jobs.length,
    completedJobs: jobs.length, // All fetched jobs are completed
    totalDurationMinutes: Math.round(totalDurationMinutes),
  };
}

function calculateUtilizationMetrics(jobs: any[]): UtilizationMetrics {
  // Calculate active time from job durations
  let activeMinutes = 0;
  
  for (const job of jobs) {
    if (job.createdAt && job.completedAt) {
      const created = new Date(job.createdAt).getTime();
      const completed = new Date(job.completedAt).getTime();
      activeMinutes += (completed - created) / (1000 * 60);
    }
  }

  // Assume 8-hour workday (480 minutes)
  const workdayMinutes = 480;
  const idleMinutes = Math.max(0, workdayMinutes - activeMinutes);

  return {
    activeMinutes: Math.round(activeMinutes),
    idleMinutes: Math.round(idleMinutes),
  };
}

function calculateRouteMetrics(jobs: any[]): RouteMetrics {
  let plannedDistanceKm = 0;
  let actualDistanceKm = 0;
  let flaggedCount = 0;

  for (const job of jobs) {
    const planned = job.plannedDistanceKm || 0;
    const actual = job.actualDistanceKm || 0;
    
    plannedDistanceKm += planned;
    actualDistanceKm += actual;

    // Flag if actual > 125% of planned
    if (planned > 0 && actual / planned > 1.25) {
      flaggedCount++;
    }
  }

  return {
    plannedDistanceKm: Math.round(plannedDistanceKm * 100) / 100,
    actualDistanceKm: Math.round(actualDistanceKm * 100) / 100,
    flaggedCount,
  };
}

async function storeMetrics(
  tenantId: string,
  dateStr: string,
  metricType: string,
  metrics: Record<string, any>
): Promise<void> {
  const tenantIdDate = `${tenantId}#${dateStr}`;
  
  await withRetry(async () => {
    await docClient.send(
      new PutCommand({
        TableName: ANALYTICS_TABLE,
        Item: {
          tenantIdDate,
          metricType,
          ...metrics,
          aggregatedAt: new Date().toISOString(),
        },
      })
    );
  });
}

async function emitMetrics(jobsProcessed: number, durationMs: number): Promise<void> {
  try {
    await cloudWatchClient.send(
      new PutMetricDataCommand({
        Namespace: "FleetTracking/Analytics",
        MetricData: [
          {
            MetricName: "JobsProcessed",
            Value: jobsProcessed,
            Unit: "Count",
          },
          {
            MetricName: "AggregationDuration",
            Value: durationMs,
            Unit: "Milliseconds",
          },
        ],
      })
    );
  } catch (error) {
    console.warn("Failed to emit CloudWatch metrics:", error);
  }
}
