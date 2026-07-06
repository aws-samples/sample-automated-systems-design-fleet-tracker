/**
 * Property Tests for Analytics API
 * Tasks 17.3, 17.4, 18.2, 19.3, 19.5: Property tests for analytics calculations
 */

import * as fc from "fast-check";
import { APIGatewayProxyEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

// Set environment variables BEFORE importing handler
process.env.ANALYTICS_TABLE = "analytics-daily";
process.env.DISPATCH_TABLE = "dispatch-assignments";

import { handler } from "./index";

const ddbMock = mockClient(DynamoDBDocumentClient);

function createEvent(
  path: string,
  queryStringParameters?: Record<string, string>,
  tenantId: string = "tenant-123"
): APIGatewayProxyEvent {
  return {
    httpMethod: "GET",
    path,
    pathParameters: null,
    queryStringParameters: queryStringParameters || null,
    multiValueQueryStringParameters: null,
    body: null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {
      authorizer: {
        claims: { "custom:tenantId": tenantId },
      },
    } as any,
    resource: "",
  };
}

describe("Analytics API Property Tests", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  /**
   * Property 32: Job Completion Count Accuracy
   * Requirements: 15.1, 15.3
   * The sum of totalJobs and completedJobs should match the aggregated values
   */
  describe("Property 32: Job Completion Count Accuracy", () => {
    it("should accurately sum job counts across multiple days", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              totalJobs: fc.integer({ min: 0, max: 100 }),
              completedJobs: fc.integer({ min: 0, max: 100 }),
              totalDurationMinutes: fc.integer({ min: 0, max: 10000 }),
            }),
            { minLength: 1, maxLength: 10 }
          ),
          async (dailyMetrics) => {
            ddbMock.reset();
            
            // Ensure completedJobs <= totalJobs
            const normalizedMetrics = dailyMetrics.map((m, i) => ({
              tenantIdDate: `tenant-123#2024-01-${String(i + 1).padStart(2, "0")}`,
              metricType: "jobs",
              totalJobs: m.totalJobs,
              completedJobs: Math.min(m.completedJobs, m.totalJobs),
              totalDurationMinutes: m.totalDurationMinutes,
            }));

            ddbMock.on(QueryCommand).resolves({ Items: normalizedMetrics });

            const event = createEvent("/analytics/jobs");
            const result = await handler(event, {} as any, () => {});

            expect(result).toBeDefined();
            expect(result!.statusCode).toBe(200);
            const body = JSON.parse(result!.body);

            const expectedTotal = normalizedMetrics.reduce((sum, m) => sum + m.totalJobs, 0);
            const expectedCompleted = normalizedMetrics.reduce((sum, m) => sum + m.completedJobs, 0);

            expect(body.totalJobs).toBe(expectedTotal);
            expect(body.completedJobs).toBe(expectedCompleted);
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Property 33: Average Job Duration Calculation
   * Requirements: 15.2
   * Average duration should be totalDurationMinutes / completedJobs
   */
  describe("Property 33: Average Job Duration Calculation", () => {
    it("should correctly calculate average duration", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 10000 }),
          async (completedJobs, totalDurationMinutes) => {
            ddbMock.reset();
            
            ddbMock.on(QueryCommand).resolves({
              Items: [
                {
                  tenantIdDate: "tenant-123#2024-01-01",
                  metricType: "jobs",
                  totalJobs: completedJobs,
                  completedJobs,
                  totalDurationMinutes,
                },
              ],
            });

            const event = createEvent("/analytics/jobs");
            const result = await handler(event, {} as any, () => {});

            expect(result).toBeDefined();
            expect(result!.statusCode).toBe(200);
            const body = JSON.parse(result!.body);

            const expectedAvg = totalDurationMinutes / completedJobs;
            expect(body.avgDurationMinutes).toBeCloseTo(expectedAvg, 1);
          }
        ),
        { numRuns: 20 }
      );
    });

    it("should return 0 when no completed jobs", async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: 1, max: 100 }), async (totalJobs) => {
          ddbMock.reset();
          
          ddbMock.on(QueryCommand).resolves({
            Items: [
              {
                tenantIdDate: "tenant-123#2024-01-01",
                metricType: "jobs",
                totalJobs,
                completedJobs: 0,
                totalDurationMinutes: 0,
              },
            ],
          });

          const event = createEvent("/analytics/jobs");
          const result = await handler(event, {} as any, () => {});

          expect(result).toBeDefined();
          expect(result!.statusCode).toBe(200);
          const body = JSON.parse(result!.body);
          expect(body.avgDurationMinutes).toBe(0);
        }),
        { numRuns: 10 }
      );
    });
  });

  /**
   * Property 34: Vehicle Utilization Calculation
   * Requirements: 16.1, 16.2, 16.3
   * Utilization percent = activeMinutes / (activeMinutes + idleMinutes) * 100
   */
  describe("Property 34: Vehicle Utilization Calculation", () => {
    it("should correctly calculate utilization percentage", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 1000 }),
          fc.integer({ min: 0, max: 1000 }),
          async (activeMinutes, idleMinutes) => {
            ddbMock.reset();
            
            ddbMock.on(QueryCommand).resolves({
              Items: [
                {
                  tenantIdDate: "tenant-123#2024-01-01",
                  metricType: "utilization",
                  vehicleId: "v1",
                  activeMinutes,
                  idleMinutes,
                },
              ],
            });

            const event = createEvent("/analytics/utilization");
            const result = await handler(event, {} as any, () => {});

            expect(result).toBeDefined();
            expect(result!.statusCode).toBe(200);
            const body = JSON.parse(result!.body);

            const total = activeMinutes + idleMinutes;
            const expectedPercent = (activeMinutes / total) * 100;

            expect(body.vehicles).toHaveLength(1);
            expect(body.vehicles[0].utilizationPercent).toBeCloseTo(expectedPercent, 1);
          }
        ),
        { numRuns: 20 }
      );
    });

    it("should aggregate utilization across multiple days for same vehicle", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(
            fc.record({
              activeMinutes: fc.integer({ min: 0, max: 500 }),
              idleMinutes: fc.integer({ min: 0, max: 500 }),
            }),
            { minLength: 2, maxLength: 5 }
          ),
          async (dailyMetrics) => {
            ddbMock.reset();
            
            const items = dailyMetrics.map((m, i) => ({
              tenantIdDate: `tenant-123#2024-01-${String(i + 1).padStart(2, "0")}`,
              metricType: "utilization",
              vehicleId: "v1",
              activeMinutes: m.activeMinutes,
              idleMinutes: m.idleMinutes,
            }));

            ddbMock.on(QueryCommand).resolves({ Items: items });

            const event = createEvent("/analytics/utilization");
            const result = await handler(event, {} as any, () => {});

            expect(result).toBeDefined();
            expect(result!.statusCode).toBe(200);
            const body = JSON.parse(result!.body);

            const totalActive = dailyMetrics.reduce((sum, m) => sum + m.activeMinutes, 0);
            const totalIdle = dailyMetrics.reduce((sum, m) => sum + m.idleMinutes, 0);

            expect(body.vehicles).toHaveLength(1);
            expect(body.vehicles[0].activeMinutes).toBe(totalActive);
            expect(body.vehicles[0].idleMinutes).toBe(totalIdle);
          }
        ),
        { numRuns: 15 }
      );
    });
  });

  /**
   * Property 35: Route Efficiency Calculation
   * Requirements: 17.1, 17.2, 17.3
   * Efficiency ratio = actualDistanceKm / plannedDistanceKm
   */
  describe("Property 35: Route Efficiency Calculation", () => {
    it("should correctly calculate efficiency ratio", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 100 }),
          fc.integer({ min: 1, max: 150 }),
          async (plannedDistanceKm, actualDistanceKm) => {
            ddbMock.reset();
            
            ddbMock.on(ScanCommand).resolves({
              Items: [
                {
                  jobId: "j1",
                  vehicleId: "v1",
                  status: "completed",
                  plannedDistanceKm,
                  actualDistanceKm,
                  completedAt: "2024-01-01T12:00:00Z",
                  tenantId: "tenant-123",
                },
              ],
            });

            const event = createEvent("/analytics/routes");
            const result = await handler(event, {} as any, () => {});

            expect(result).toBeDefined();
            expect(result!.statusCode).toBe(200);
            const body = JSON.parse(result!.body);

            const expectedRatio = actualDistanceKm / plannedDistanceKm;
            expect(body.routes).toHaveLength(1);
            expect(body.routes[0].efficiencyRatio).toBeCloseTo(expectedRatio, 1);
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Property 36: Route Efficiency Flagging
   * Requirements: 17.4
   * Routes with efficiency > 125% should be flagged for review
   */
  describe("Property 36: Route Efficiency Flagging", () => {
    it("should flag routes exceeding 125% efficiency threshold", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 10, max: 100 }),
          fc.integer({ min: 126, max: 200 }),
          async (plannedDistanceKm, efficiencyPercent) => {
            ddbMock.reset();
            const actualDistanceKm = plannedDistanceKm * (efficiencyPercent / 100);

            ddbMock.on(ScanCommand).resolves({
              Items: [
                {
                  jobId: "j1",
                  vehicleId: "v1",
                  status: "completed",
                  plannedDistanceKm,
                  actualDistanceKm,
                  completedAt: "2024-01-01T12:00:00Z",
                  tenantId: "tenant-123",
                },
              ],
            });

            const event = createEvent("/analytics/routes");
            const result = await handler(event, {} as any, () => {});

            expect(result).toBeDefined();
            expect(result!.statusCode).toBe(200);
            const body = JSON.parse(result!.body);

            expect(body.routes[0].flaggedForReview).toBe(true);
          }
        ),
        { numRuns: 15 }
      );
    });

    it("should not flag routes within 125% efficiency threshold", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 10, max: 100 }),
          fc.integer({ min: 50, max: 124 }),
          async (plannedDistanceKm, efficiencyPercent) => {
            ddbMock.reset();
            const actualDistanceKm = plannedDistanceKm * (efficiencyPercent / 100);

            ddbMock.on(ScanCommand).resolves({
              Items: [
                {
                  jobId: "j1",
                  vehicleId: "v1",
                  status: "completed",
                  plannedDistanceKm,
                  actualDistanceKm,
                  completedAt: "2024-01-01T12:00:00Z",
                  tenantId: "tenant-123",
                },
              ],
            });

            const event = createEvent("/analytics/routes");
            const result = await handler(event, {} as any, () => {});

            expect(result).toBeDefined();
            expect(result!.statusCode).toBe(200);
            const body = JSON.parse(result!.body);

            expect(body.routes[0].flaggedForReview).toBe(false);
          }
        ),
        { numRuns: 15 }
      );
    });
  });
});
