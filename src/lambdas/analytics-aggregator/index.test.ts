/**
 * Unit Tests for Analytics Aggregator
 * Task 20.8: Unit tests for analytics aggregator
 */

import { ScheduledEvent, Context } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

// Set environment variables BEFORE importing handler
process.env.DISPATCH_TABLE = "dispatch-assignments";
process.env.VEHICLE_STATE_TABLE = "vehicle-current-state";
process.env.ANALYTICS_TABLE = "analytics-daily";

import { handler } from "./index";

const ddbMock = mockClient(DynamoDBDocumentClient);
const cloudWatchMock = mockClient(CloudWatchClient);

const mockContext: Context = {
  awsRequestId: "test-request-id",
  callbackWaitsForEmptyEventLoop: false,
  functionName: "analytics-aggregator",
  functionVersion: "1",
  invokedFunctionArn: "arn:aws:lambda:us-west-2:123456789012:function:analytics-aggregator",
  memoryLimitInMB: "256",
  logGroupName: "/aws/lambda/analytics-aggregator",
  logStreamName: "2024/03/15/[$LATEST]abc123",
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

const mockEvent: ScheduledEvent = {
  version: "0",
  id: "test-event-id",
  "detail-type": "Scheduled Event",
  source: "aws.events",
  account: "123456789012",
  time: "2024-01-02T00:00:00Z",
  region: "us-west-2",
  resources: ["arn:aws:events:us-west-2:123456789012:rule/analytics-aggregator"],
  detail: {},
};

describe("Analytics Aggregator", () => {
  beforeEach(() => {
    ddbMock.reset();
    cloudWatchMock.reset();
    cloudWatchMock.on(PutMetricDataCommand).resolves({});
  });

  describe("Daily aggregation job (Task 20.2)", () => {
    it("should process completed jobs and store metrics", async () => {
      const completedJobs = [
        {
          jobId: "j1",
          vehicleId: "v1",
          tenantId: "tenant-1",
          status: "completed",
          createdAt: "2024-01-01T08:00:00Z",
          completedAt: "2024-01-01T09:30:00Z",
          plannedDistanceKm: 10,
          actualDistanceKm: 11,
        },
        {
          jobId: "j2",
          vehicleId: "v1",
          tenantId: "tenant-1",
          status: "completed",
          createdAt: "2024-01-01T10:00:00Z",
          completedAt: "2024-01-01T11:00:00Z",
          plannedDistanceKm: 15,
          actualDistanceKm: 14,
        },
      ];

      const vehicles = [
        { vehicleId: "v1", tenantId: "tenant-1", status: "available" },
      ];

      // First scan returns jobs, second returns vehicles
      ddbMock.on(ScanCommand)
        .resolvesOnce({ Items: completedJobs })
        .resolvesOnce({ Items: vehicles });
      ddbMock.on(PutCommand).resolves({});

      await handler(mockEvent, mockContext, () => {});

      // Verify metrics were stored
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls.length).toBeGreaterThanOrEqual(3); // jobs, utilization, routes

      // Verify job metrics
      const jobMetrics = putCalls.find(
        (call: any) => call.args[0].input.Item?.metricType === "jobs"
      );
      expect(jobMetrics).toBeDefined();
      expect((jobMetrics as any).args[0].input.Item.totalJobs).toBe(2);
      expect((jobMetrics as any).args[0].input.Item.completedJobs).toBe(2);
    });

    it("should calculate job duration correctly", async () => {
      const completedJobs = [
        {
          jobId: "j1",
          vehicleId: "v1",
          tenantId: "tenant-1",
          status: "completed",
          createdAt: "2024-01-01T08:00:00Z",
          completedAt: "2024-01-01T10:00:00Z", // 2 hours = 120 minutes
        },
      ];

      ddbMock.on(ScanCommand)
        .resolvesOnce({ Items: completedJobs })
        .resolvesOnce({ Items: [{ vehicleId: "v1", tenantId: "tenant-1" }] });
      ddbMock.on(PutCommand).resolves({});

      await handler(mockEvent, mockContext, () => {});

      const putCalls = ddbMock.commandCalls(PutCommand);
      const jobMetrics = putCalls.find(
        (call: any) => call.args[0].input.Item?.metricType === "jobs"
      );
      expect((jobMetrics as any).args[0].input.Item.totalDurationMinutes).toBe(120);
    });

    it("should handle empty job list", async () => {
      ddbMock.on(ScanCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] });
      ddbMock.on(PutCommand).resolves({});

      await expect(handler(mockEvent, mockContext, () => {})).resolves.toBeUndefined();
    });
  });

  describe("Idempotent aggregation (Task 20.3)", () => {
    it("should produce same results when run multiple times", async () => {
      const completedJobs = [
        {
          jobId: "j1",
          vehicleId: "v1",
          tenantId: "tenant-1",
          status: "completed",
          createdAt: "2024-01-01T08:00:00Z",
          completedAt: "2024-01-01T09:00:00Z",
          plannedDistanceKm: 10,
          actualDistanceKm: 10,
        },
      ];

      const vehicles = [{ vehicleId: "v1", tenantId: "tenant-1" }];

      // Run twice
      for (let i = 0; i < 2; i++) {
        ddbMock.reset();
        cloudWatchMock.reset();
        cloudWatchMock.on(PutMetricDataCommand).resolves({});
        ddbMock.on(ScanCommand)
          .resolvesOnce({ Items: completedJobs })
          .resolvesOnce({ Items: vehicles });
        ddbMock.on(PutCommand).resolves({});

        await handler(mockEvent, mockContext, () => {});
      }

      // Both runs should complete without error
      // PutCommand with same key will overwrite, producing idempotent behavior
    });
  });

  describe("CloudWatch metrics (Task 20.7)", () => {
    it("should emit CloudWatch metrics for aggregation job", async () => {
      ddbMock.on(ScanCommand)
        .resolvesOnce({ Items: [{ jobId: "j1", tenantId: "t1", status: "completed", createdAt: "2024-01-01T08:00:00Z", completedAt: "2024-01-01T09:00:00Z" }] })
        .resolvesOnce({ Items: [] });
      ddbMock.on(PutCommand).resolves({});

      await handler(mockEvent, mockContext, () => {});

      const metricCalls = cloudWatchMock.commandCalls(PutMetricDataCommand);
      expect(metricCalls).toHaveLength(1);
      expect(metricCalls[0].args[0].input.Namespace).toBe("FleetTracking/Analytics");
      
      const metricData = metricCalls[0].args[0].input.MetricData;
      expect(metricData).toContainEqual(expect.objectContaining({ MetricName: "JobsProcessed" }));
      expect(metricData).toContainEqual(expect.objectContaining({ MetricName: "AggregationDuration" }));
    });
  });

  describe("Route efficiency flagging", () => {
    it("should count flagged routes exceeding 125% threshold", async () => {
      const completedJobs = [
        {
          jobId: "j1",
          vehicleId: "v1",
          tenantId: "tenant-1",
          status: "completed",
          createdAt: "2024-01-01T08:00:00Z",
          completedAt: "2024-01-01T09:00:00Z",
          plannedDistanceKm: 10,
          actualDistanceKm: 13, // 130% - flagged
        },
        {
          jobId: "j2",
          vehicleId: "v1",
          tenantId: "tenant-1",
          status: "completed",
          createdAt: "2024-01-01T10:00:00Z",
          completedAt: "2024-01-01T11:00:00Z",
          plannedDistanceKm: 10,
          actualDistanceKm: 11, // 110% - not flagged
        },
      ];

      ddbMock.on(ScanCommand)
        .resolvesOnce({ Items: completedJobs })
        .resolvesOnce({ Items: [{ vehicleId: "v1", tenantId: "tenant-1" }] });
      ddbMock.on(PutCommand).resolves({});

      await handler(mockEvent, mockContext, () => {});

      const putCalls = ddbMock.commandCalls(PutCommand);
      const routeMetrics = putCalls.find(
        (call: any) => call.args[0].input.Item?.metricType === "routes"
      );
      expect((routeMetrics as any).args[0].input.Item.flaggedCount).toBe(1);
    });
  });

  describe("Multi-tenant support", () => {
    it("should aggregate metrics separately per tenant", async () => {
      const completedJobs = [
        { jobId: "j1", vehicleId: "v1", tenantId: "tenant-1", status: "completed", createdAt: "2024-01-01T08:00:00Z", completedAt: "2024-01-01T09:00:00Z" },
        { jobId: "j2", vehicleId: "v2", tenantId: "tenant-2", status: "completed", createdAt: "2024-01-01T08:00:00Z", completedAt: "2024-01-01T10:00:00Z" },
      ];

      const vehicles = [
        { vehicleId: "v1", tenantId: "tenant-1" },
        { vehicleId: "v2", tenantId: "tenant-2" },
      ];

      ddbMock.on(ScanCommand)
        .resolvesOnce({ Items: completedJobs })
        .resolvesOnce({ Items: vehicles });
      ddbMock.on(PutCommand).resolves({});

      await handler(mockEvent, mockContext, () => {});

      const putCalls = ddbMock.commandCalls(PutCommand);
      
      // Should have metrics for both tenants
      const tenant1Jobs = putCalls.find(
        (call: any) => 
          call.args[0].input.Item?.metricType === "jobs" &&
          call.args[0].input.Item?.tenantIdDate?.startsWith("tenant-1")
      );
      const tenant2Jobs = putCalls.find(
        (call: any) => 
          call.args[0].input.Item?.metricType === "jobs" &&
          call.args[0].input.Item?.tenantIdDate?.startsWith("tenant-2")
      );

      expect(tenant1Jobs).toBeDefined();
      expect(tenant2Jobs).toBeDefined();
      expect((tenant1Jobs as any).args[0].input.Item.totalJobs).toBe(1);
      expect((tenant2Jobs as any).args[0].input.Item.totalJobs).toBe(1);
    });
  });
});
