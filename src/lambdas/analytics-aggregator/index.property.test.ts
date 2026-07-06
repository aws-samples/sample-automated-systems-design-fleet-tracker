/**
 * Property Tests for Analytics Aggregator
 * Tasks 20.4, 20.5: Property tests for aggregation idempotence and completeness
 */

import * as fc from "fast-check";
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
  resources: [],
  detail: {},
};

// Arbitraries
const jobIdArb = fc.uuid();
const vehicleIdArb = fc.stringMatching(/^vehicle-[0-9]{3}$/);
const tenantIdArb = fc.uuid();

describe("Analytics Aggregator Property Tests", () => {
  beforeEach(() => {
    ddbMock.reset();
    cloudWatchMock.reset();
    cloudWatchMock.on(PutMetricDataCommand).resolves({});
  });

  /**
   * Property 37: Analytics Aggregation Idempotence
   * Requirements: 19.4
   * Re-running aggregation produces same results
   */
  describe("Property 37: Analytics Aggregation Idempotence", () => {
    it("should produce identical metrics when run multiple times with same data", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              jobId: jobIdArb,
              vehicleId: vehicleIdArb,
              durationMinutes: fc.integer({ min: 10, max: 480 }),
              plannedDistanceKm: fc.integer({ min: 1, max: 100 }),
              actualDistanceKm: fc.integer({ min: 1, max: 150 }),
            }),
            { minLength: 1, maxLength: 5 }
          ),
          tenantIdArb,
          async (jobData, tenantId) => {
            const completedJobs = jobData.map((j, i) => {
              const createdAt = new Date("2024-01-01T08:00:00Z");
              const completedAt = new Date(createdAt.getTime() + j.durationMinutes * 60 * 1000);
              return {
                jobId: j.jobId,
                vehicleId: j.vehicleId,
                tenantId,
                status: "completed",
                createdAt: createdAt.toISOString(),
                completedAt: completedAt.toISOString(),
                plannedDistanceKm: j.plannedDistanceKm,
                actualDistanceKm: j.actualDistanceKm,
              };
            });

            const vehicles = [...new Set(jobData.map(j => j.vehicleId))].map(vid => ({
              vehicleId: vid,
              tenantId,
            }));

            const storedMetrics: any[][] = [];

            // Run aggregation twice
            for (let run = 0; run < 2; run++) {
              ddbMock.reset();
              cloudWatchMock.reset();
              cloudWatchMock.on(PutMetricDataCommand).resolves({});
              
              ddbMock.on(ScanCommand)
                .resolvesOnce({ Items: completedJobs })
                .resolvesOnce({ Items: vehicles });
              ddbMock.on(PutCommand).resolves({});

              await handler(mockEvent, mockContext, () => {});

              const putCalls = ddbMock.commandCalls(PutCommand);
              storedMetrics.push(putCalls.map((c: any) => c.args[0].input.Item));
            }

            // Compare metrics from both runs (excluding aggregatedAt timestamp)
            const normalize = (items: any[]) => 
              items.map(item => {
                const { aggregatedAt, ...rest } = item;
                return rest;
              }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

            const run1 = normalize(storedMetrics[0]);
            const run2 = normalize(storedMetrics[1]);

            expect(run1).toEqual(run2);
          }
        ),
        { numRuns: 10 }
      );
    });
  });

  /**
   * Property 38: Analytics Aggregation Completeness
   * Requirements: 19.2
   * All completed jobs are included in aggregation
   */
  describe("Property 38: Analytics Aggregation Completeness", () => {
    it("should include all completed jobs in job count", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          tenantIdArb,
          async (jobCount, tenantId) => {
            ddbMock.reset();
            cloudWatchMock.reset();
            cloudWatchMock.on(PutMetricDataCommand).resolves({});

            const completedJobs = Array.from({ length: jobCount }, (_, i) => ({
              jobId: `job-${i}`,
              vehicleId: "vehicle-001",
              tenantId,
              status: "completed",
              createdAt: "2024-01-01T08:00:00Z",
              completedAt: "2024-01-01T09:00:00Z",
            }));

            const vehicles = [{ vehicleId: "vehicle-001", tenantId }];

            ddbMock.on(ScanCommand)
              .resolvesOnce({ Items: completedJobs })
              .resolvesOnce({ Items: vehicles });
            ddbMock.on(PutCommand).resolves({});

            await handler(mockEvent, mockContext, () => {});

            const putCalls = ddbMock.commandCalls(PutCommand);
            const jobMetrics = putCalls.find(
              (call: any) => call.args[0].input.Item?.metricType === "jobs"
            );

            expect(jobMetrics).toBeDefined();
            expect((jobMetrics as any).args[0].input.Item.totalJobs).toBe(jobCount);
            expect((jobMetrics as any).args[0].input.Item.completedJobs).toBe(jobCount);
          }
        ),
        { numRuns: 15 }
      );
    });

    it("should correctly sum total duration across all jobs", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.integer({ min: 10, max: 120 }),
            { minLength: 1, maxLength: 5 }
          ),
          tenantIdArb,
          async (durations, tenantId) => {
            ddbMock.reset();
            cloudWatchMock.reset();
            cloudWatchMock.on(PutMetricDataCommand).resolves({});

            const completedJobs = durations.map((duration, i) => {
              const createdAt = new Date("2024-01-01T08:00:00Z");
              const completedAt = new Date(createdAt.getTime() + duration * 60 * 1000);
              return {
                jobId: `job-${i}`,
                vehicleId: "vehicle-001",
                tenantId,
                status: "completed",
                createdAt: createdAt.toISOString(),
                completedAt: completedAt.toISOString(),
              };
            });

            const vehicles = [{ vehicleId: "vehicle-001", tenantId }];

            ddbMock.on(ScanCommand)
              .resolvesOnce({ Items: completedJobs })
              .resolvesOnce({ Items: vehicles });
            ddbMock.on(PutCommand).resolves({});

            await handler(mockEvent, mockContext, () => {});

            const putCalls = ddbMock.commandCalls(PutCommand);
            const jobMetrics = putCalls.find(
              (call: any) => call.args[0].input.Item?.metricType === "jobs"
            );

            const expectedTotalDuration = durations.reduce((sum, d) => sum + d, 0);
            expect((jobMetrics as any).args[0].input.Item.totalDurationMinutes).toBe(expectedTotalDuration);
          }
        ),
        { numRuns: 15 }
      );
    });
  });
});
