/**
 * Property-Based Tests for Multi-Tenant Data Isolation
 * 
 * Tests universal correctness properties using fast-check library.
 * 
 * Properties tested:
 * - Property 23: Tenant Data Isolation - Records (Requirements 12.1, 12.2)
 * - Property 24: Tenant Data Isolation - Queries (Requirements 12.3, 12.4)
 * - Property 25: Cross-Tenant Access Denied (Requirements 12.5)
 */

import * as fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, QueryCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { LocationClient, SearchPlaceIndexForTextCommand, CalculateRouteCommand, PutGeofenceCommand } from "@aws-sdk/client-location";
import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";
import { APIGatewayProxyEvent } from "aws-lambda";

// Set environment variables BEFORE importing handler
process.env.VEHICLE_STATE_TABLE = "vehicle-current-state";
process.env.DISPATCH_TABLE = "dispatch-assignments";
process.env.GPS_HISTORY_TABLE = "gps-history";
process.env.PLACE_INDEX_NAME = "fleet-places";
process.env.ROUTE_CALCULATOR_NAME = "fleet-routes";
process.env.GEOFENCE_COLLECTION_NAME = "job-sites";
process.env.EMAIL_SUBSCRIPTIONS_TABLE = "email-subscriptions";

// Import handler AFTER setting environment variables
import { handler } from "./index";

// Mock AWS clients
const ddbMock = mockClient(DynamoDBDocumentClient);
const locationMock = mockClient(LocationClient);
const iotMock = mockClient(IoTDataPlaneClient);

// Arbitrary generators
const tenantIdArb = fc.stringMatching(/^tenant-[a-z0-9]{8}$/);
const vehicleIdArb = fc.stringMatching(/^vehicle-[0-9]{3}$/);
const jobIdArb = fc.uuid();

// Helper to create API Gateway event
function createEvent(
  httpMethod: string,
  path: string,
  options: {
    pathParameters?: Record<string, string>;
    queryStringParameters?: Record<string, string>;
    body?: unknown;
    tenantId?: string;
  } = {}
): APIGatewayProxyEvent {
  return {
    httpMethod,
    path,
    pathParameters: options.pathParameters || null,
    queryStringParameters: options.queryStringParameters || null,
    multiValueQueryStringParameters: null,
    body: options.body ? JSON.stringify(options.body) : null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {
      accountId: "123456789012",
      apiId: "test-api",
      authorizer: options.tenantId ? {
        claims: {
          "custom:tenantId": options.tenantId,
        },
      } : {},
      protocol: "HTTP/1.1",
      httpMethod,
      identity: {
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: "127.0.0.1",
        user: null,
        userAgent: "test",
        userArn: null,
      },
      path,
      stage: "test",
      requestId: "test-request-id",
      requestTimeEpoch: Date.now(),
      resourceId: "test-resource",
      resourcePath: path,
    },
    resource: path,
  };
}

describe("Multi-Tenant Data Isolation Property Tests", () => {
  beforeEach(() => {
    ddbMock.reset();
    locationMock.reset();
    iotMock.reset();
    jest.clearAllMocks();
  });

  /**
   * Property 23: Tenant Data Isolation - Records
   * Requirements: 12.1, 12.2
   * 
   * For any job creation, the tenantId from the authenticated user should be
   * stored with the dispatch assignment record.
   */
  describe("Property 23: Tenant Data Isolation - Records", () => {
    it("should store tenantId on job creation", async () => {
      await fc.assert(
        fc.asyncProperty(tenantIdArb, vehicleIdArb, async (tenantId, vehicleId) => {
          ddbMock.reset();
          locationMock.reset();
          iotMock.reset();

          // Mock vehicle exists and is available
          ddbMock.on(GetCommand).resolves({
            Item: {
              vehicleId,
              status: "available",
              position: { lat: 37.7749, lng: -122.4194 },
            },
          });
          ddbMock.on(PutCommand).resolves({});
          ddbMock.on(UpdateCommand).resolves({});

          // Mock geocoding and route calculation
          locationMock.on(SearchPlaceIndexForTextCommand).resolves({
            Results: [{ Place: { Geometry: { Point: [-122.4094, 37.7849] }, Label: "123 Main St" } }],
          });
          locationMock.on(CalculateRouteCommand).resolves({
            Summary: { 
              DurationSeconds: 600, 
              Distance: 5,
              RouteBBox: [-122.5, 37.7, -122.4, 37.8],
              DataSource: "Esri",
              DistanceUnit: "Kilometers"
            },
          });
          locationMock.on(PutGeofenceCommand).resolves({});
          iotMock.on(PublishCommand).resolves({});

          const event = createEvent("POST", "/jobs", {
            body: { address: "123 Main St", vehicleId },
            tenantId,
          });

          const result = await handler(event);
          expect(result.statusCode).toBe(201);

          // Verify PutCommand was called with tenantId
          const putCalls = ddbMock.commandCalls(PutCommand);
          expect(putCalls.length).toBeGreaterThanOrEqual(1);
          
          const dispatchPut = putCalls.find(call => 
            call.args[0].input.TableName === "dispatch-assignments"
          );
          expect(dispatchPut).toBeDefined();
          expect(dispatchPut!.args[0].input.Item?.tenantId).toBe(tenantId);
        }),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Property 24: Tenant Data Isolation - Queries
   * Requirements: 12.3, 12.4
   * 
   * For any vehicle list query, only vehicles belonging to the authenticated
   * tenant should be returned.
   */
  describe("Property 24: Tenant Data Isolation - Queries", () => {
    it("should filter vehicles by tenantId in list queries", async () => {
      await fc.assert(
        fc.asyncProperty(tenantIdArb, async (tenantId) => {
          ddbMock.reset();

          // Mock vehicles from multiple tenants
          const vehicles = [
            { vehicleId: "vehicle-001", tenantId, status: "available" },
            { vehicleId: "vehicle-002", tenantId: "other-tenant", status: "available" },
            { vehicleId: "vehicle-003", tenantId, status: "en-route" },
          ];
          ddbMock.on(ScanCommand).resolves({ Items: vehicles });

          const event = createEvent("GET", "/vehicles", { tenantId });
          const result = await handler(event);

          expect(result.statusCode).toBe(200);
          
          // Verify ScanCommand was called with filter expression
          const scanCalls = ddbMock.commandCalls(ScanCommand);
          expect(scanCalls.length).toBe(1);
          expect(scanCalls[0].args[0].input.FilterExpression).toContain("tenantId");
        }),
        { numRuns: 20 }
      );
    });

    it("should filter jobs by tenantId in list queries", async () => {
      await fc.assert(
        fc.asyncProperty(tenantIdArb, async (tenantId) => {
          ddbMock.reset();

          // Mock jobs from multiple tenants
          const jobs = [
            { jobId: "job-1", vehicleId: "vehicle-001", tenantId, status: "en-route" },
            { jobId: "job-2", vehicleId: "vehicle-002", tenantId: "other-tenant", status: "completed" },
          ];
          ddbMock.on(ScanCommand).resolves({ Items: jobs });

          const event = createEvent("GET", "/jobs", { tenantId });
          const result = await handler(event);

          expect(result.statusCode).toBe(200);
          
          // Verify ScanCommand was called with filter expression
          const scanCalls = ddbMock.commandCalls(ScanCommand);
          expect(scanCalls.length).toBe(1);
          expect(scanCalls[0].args[0].input.FilterExpression).toContain("tenantId");
        }),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Property 25: Cross-Tenant Access Denied
   * Requirements: 12.5
   * 
   * For any attempt to access a resource belonging to a different tenant,
   * the API should return 403 Forbidden.
   */
  describe("Property 25: Cross-Tenant Access Denied", () => {
    it("should deny access to vehicle belonging to different tenant", async () => {
      await fc.assert(
        fc.asyncProperty(
          tenantIdArb,
          tenantIdArb,
          vehicleIdArb,
          async (requestingTenantId, owningTenantId, vehicleId) => {
            // Skip if tenants are the same
            if (requestingTenantId === owningTenantId) return;

            ddbMock.reset();

            // Mock vehicle belonging to different tenant
            ddbMock.on(GetCommand).resolves({
              Item: {
                vehicleId,
                tenantId: owningTenantId,
                status: "available",
                position: { lat: 37.7749, lng: -122.4194 },
              },
            });

            const event = createEvent("GET", `/vehicles/${vehicleId}`, {
              pathParameters: { id: vehicleId },
              tenantId: requestingTenantId,
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(403);
            
            const body = JSON.parse(result.body);
            expect(body.error).toBe("Forbidden");
          }
        ),
        { numRuns: 20 }
      );
    });

    it("should deny job update for job belonging to different tenant", async () => {
      await fc.assert(
        fc.asyncProperty(
          tenantIdArb,
          tenantIdArb,
          jobIdArb,
          vehicleIdArb,
          async (requestingTenantId, owningTenantId, jobId, vehicleId) => {
            // Skip if tenants are the same
            if (requestingTenantId === owningTenantId) return;

            ddbMock.reset();

            // Mock job belonging to different tenant
            ddbMock.on(QueryCommand).resolves({
              Items: [{
                jobId,
                vehicleId,
                tenantId: owningTenantId,
                status: "en-route",
              }],
            });

            const event = createEvent("PUT", `/jobs/${jobId}`, {
              pathParameters: { id: jobId },
              body: { status: "completed", vehicleId },
              tenantId: requestingTenantId,
            });

            const result = await handler(event);
            expect(result.statusCode).toBe(403);
            
            const body = JSON.parse(result.body);
            expect(body.error).toBe("Forbidden");
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});
