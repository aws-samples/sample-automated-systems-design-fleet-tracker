/**
 * Unit Tests for Analytics API
 * Task 19.6: Unit tests for analytics endpoints
 */

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
  queryStringParameters?: Record<string, string>
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
        claims: { "custom:tenantId": "tenant-123" },
      },
    } as any,
    resource: "",
  };
}

describe("Analytics API", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  describe("GET /analytics/jobs (Task 17.2)", () => {
    it("should return job metrics aggregated from analytics table", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { tenantIdDate: "tenant-123#2024-01-01", metricType: "jobs", totalJobs: 10, completedJobs: 8, totalDurationMinutes: 480 },
          { tenantIdDate: "tenant-123#2024-01-02", metricType: "jobs", totalJobs: 12, completedJobs: 11, totalDurationMinutes: 550 },
        ],
      });

      const event = createEvent("/analytics/jobs", { startDate: "2024-01-01", endDate: "2024-01-02" });
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(200);
      const body = JSON.parse(result!.body);
      expect(body.totalJobs).toBe(22);
      expect(body.completedJobs).toBe(19);
      expect(body.completionRate).toBeCloseTo(86.36, 1);
      expect(body.avgDurationMinutes).toBeCloseTo(54.21, 1);
    });

    it("should filter by vehicleId when provided", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { tenantIdDate: "tenant-123#2024-01-01", metricType: "jobs", vehicleId: "v1", totalJobs: 5, completedJobs: 4, totalDurationMinutes: 200 },
          { tenantIdDate: "tenant-123#2024-01-01", metricType: "jobs", vehicleId: "v2", totalJobs: 5, completedJobs: 5, totalDurationMinutes: 250 },
        ],
      });

      const event = createEvent("/analytics/jobs", { vehicleId: "v1" });
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(200);
      const body = JSON.parse(result!.body);
      expect(body.totalJobs).toBe(5);
      expect(body.completedJobs).toBe(4);
    });

    it("should return zeros when no data exists", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const event = createEvent("/analytics/jobs");
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(200);
      const body = JSON.parse(result!.body);
      expect(body.totalJobs).toBe(0);
      expect(body.completedJobs).toBe(0);
      expect(body.completionRate).toBe(0);
      expect(body.avgDurationMinutes).toBe(0);
    });
  });

  describe("GET /analytics/utilization (Task 18.1)", () => {
    it("should return utilization metrics per vehicle", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { tenantIdDate: "tenant-123#2024-01-01", metricType: "utilization", vehicleId: "v1", activeMinutes: 360, idleMinutes: 120 },
          { tenantIdDate: "tenant-123#2024-01-02", metricType: "utilization", vehicleId: "v1", activeMinutes: 400, idleMinutes: 80 },
        ],
      });

      const event = createEvent("/analytics/utilization");
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(200);
      const body = JSON.parse(result!.body);
      expect(body.vehicles).toHaveLength(1);
      expect(body.vehicles[0].vehicleId).toBe("v1");
      expect(body.vehicles[0].activeMinutes).toBe(760);
      expect(body.vehicles[0].idleMinutes).toBe(200);
      expect(body.vehicles[0].utilizationPercent).toBeCloseTo(79.17, 1);
    });

    it("should aggregate multiple vehicles", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { tenantIdDate: "tenant-123#2024-01-01", metricType: "utilization", vehicleId: "v1", activeMinutes: 300, idleMinutes: 180 },
          { tenantIdDate: "tenant-123#2024-01-01", metricType: "utilization", vehicleId: "v2", activeMinutes: 450, idleMinutes: 30 },
        ],
      });

      const event = createEvent("/analytics/utilization");
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(200);
      const body = JSON.parse(result!.body);
      expect(body.vehicles).toHaveLength(2);
    });
  });

  describe("GET /analytics/routes (Task 19.2)", () => {
    it("should return route efficiency metrics", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          { jobId: "j1", vehicleId: "v1", status: "completed", plannedDistanceKm: 10, actualDistanceKm: 11, completedAt: "2024-01-01T12:00:00Z", tenantId: "tenant-123" },
          { jobId: "j2", vehicleId: "v1", status: "completed", plannedDistanceKm: 20, actualDistanceKm: 28, completedAt: "2024-01-01T14:00:00Z", tenantId: "tenant-123" },
        ],
      });

      const event = createEvent("/analytics/routes");
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(200);
      const body = JSON.parse(result!.body);
      expect(body.routes).toHaveLength(2);
      expect(body.routes[0].efficiencyRatio).toBe(1.1);
      expect(body.routes[0].flaggedForReview).toBe(false);
      expect(body.routes[1].efficiencyRatio).toBe(1.4);
      expect(body.routes[1].flaggedForReview).toBe(true);
    });

    it("should flag routes with efficiency > 125%", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          { jobId: "j1", vehicleId: "v1", status: "completed", plannedDistanceKm: 10, actualDistanceKm: 12.4, completedAt: "2024-01-01T12:00:00Z", tenantId: "tenant-123" },
          { jobId: "j2", vehicleId: "v1", status: "completed", plannedDistanceKm: 10, actualDistanceKm: 12.6, completedAt: "2024-01-01T14:00:00Z", tenantId: "tenant-123" },
        ],
      });

      const event = createEvent("/analytics/routes");
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(200);
      const body = JSON.parse(result!.body);
      expect(body.routes[0].flaggedForReview).toBe(false); // 124% - not flagged
      expect(body.routes[1].flaggedForReview).toBe(true);  // 126% - flagged
    });

    it("should filter by tenant", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          { jobId: "j1", vehicleId: "v1", status: "completed", plannedDistanceKm: 10, actualDistanceKm: 11, completedAt: "2024-01-01T12:00:00Z", tenantId: "tenant-123" },
          { jobId: "j2", vehicleId: "v2", status: "completed", plannedDistanceKm: 20, actualDistanceKm: 22, completedAt: "2024-01-01T14:00:00Z", tenantId: "other-tenant" },
        ],
      });

      const event = createEvent("/analytics/routes");
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(200);
      const body = JSON.parse(result!.body);
      expect(body.routes).toHaveLength(1);
      expect(body.routes[0].jobId).toBe("j1");
    });
  });

  describe("Error handling", () => {
    it("should return 404 for unknown path", async () => {
      const event = createEvent("/analytics/unknown");
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(404);
    });

    it("should return 500 on DynamoDB error", async () => {
      ddbMock.on(QueryCommand).rejects(new Error("DynamoDB error"));

      const event = createEvent("/analytics/jobs");
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(500);
    });
  });
});
