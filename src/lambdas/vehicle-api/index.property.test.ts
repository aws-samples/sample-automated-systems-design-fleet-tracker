/**
 * Property Tests for Vehicle API Lambda
 * Tasks 6.2, 6.4, 6.6, 6.7, 6.8
 * 
 * Property Tests:
 * - Property 11: Email Subscription Round-Trip (Req 3.7)
 * - Property 6: Job Assignment Requires Available Status (Req 4.7, 4.8)
 * - Property 7: Geofence Coordinate Validation (Req 5.4)
 * - Property 8: Geofence Round-Trip (Req 5.5)
 * - Property 9: Geofence Naming Convention (Req 4.3, 5.2)
 */

// Set environment variables BEFORE importing the handler
process.env.VEHICLE_STATE_TABLE = "vehicle-current-state";
process.env.DISPATCH_TABLE = "dispatch-assignments";
process.env.GPS_HISTORY_TABLE = "gps-history";
process.env.PLACE_INDEX_NAME = "fleet-places";
process.env.ROUTE_CALCULATOR_NAME = "fleet-routes";
process.env.GEOFENCE_COLLECTION_NAME = "job-sites";
process.env.EMAIL_SUBSCRIPTIONS_TABLE = "email-subscriptions";

import { handler } from "./index";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import {
  LocationClient,
  SearchPlaceIndexForTextCommand,
  CalculateRouteCommand,
  PutGeofenceCommand,
} from "@aws-sdk/client-location";
import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";
import * as fc from "fast-check";
import type { APIGatewayProxyEvent } from "aws-lambda";
import type { VehicleStatus } from "../../shared/types";

const ddbMock = mockClient(DynamoDBDocumentClient);
const locationMock = mockClient(LocationClient);
const iotMock = mockClient(IoTDataPlaneClient);

function createAPIEvent(
  method: string,
  path: string,
  body?: unknown,
  pathParameters?: Record<string, string>,
  queryStringParameters?: Record<string, string>
): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    path,
    body: body ? JSON.stringify(body) : null,
    pathParameters: pathParameters || null,
    queryStringParameters: queryStringParameters || null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {
      accountId: "123456789",
      apiId: "test-api",
      authorizer: { claims: { "custom:tenantId": "tenant-abc" } },
      httpMethod: method,
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
        userAgent: null,
        userArn: null,
      },
      path,
      protocol: "HTTP/1.1",
      requestId: "test-request-id",
      requestTimeEpoch: Date.now(),
      resourceId: "test-resource",
      resourcePath: path,
      stage: "test",
    },
    resource: path,
    multiValueQueryStringParameters: null,
  };
}

describe("Vehicle API Property Tests", () => {
  beforeEach(() => {
    ddbMock.reset();
    locationMock.reset();
    iotMock.reset();
  });

  /**
   * Property 11: Email Subscription Round-Trip
   * Requirements: 3.7
   * 
   * For any valid email address:
   * - POST /subscriptions/email creates a subscription
   * - DELETE /subscriptions/email removes the subscription
   */
  describe("Property 11: Email Subscription Round-Trip", () => {
    // Arbitrary for valid email addresses
    const validEmailArb = fc.tuple(
      fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-z0-9]+$/.test(s)),
      fc.constantFrom("example.com", "test.org", "company.io", "mail.net")
    ).map(([local, domain]) => `${local}@${domain}`);

    it("should create and delete email subscriptions for any valid email", async () => {
      await fc.assert(
        fc.asyncProperty(validEmailArb, async (email) => {
          ddbMock.reset();
          
          // Mock successful DynamoDB operations
          ddbMock.on(PutCommand).resolves({});
          ddbMock.on(DeleteCommand).resolves({});

          // Subscribe
          const subscribeEvent = createAPIEvent("POST", "/subscriptions/email", { email });
          const subscribeResult = await handler(subscribeEvent);
          
          expect(subscribeResult.statusCode).toBe(201);
          const subscribeBody = JSON.parse(subscribeResult.body);
          expect(subscribeBody.email).toBe(email);
          expect(subscribeBody.tenantId).toBe("tenant-abc");

          // Unsubscribe
          const unsubscribeEvent = createAPIEvent("DELETE", "/subscriptions/email", { email });
          const unsubscribeResult = await handler(unsubscribeEvent);
          
          expect(unsubscribeResult.statusCode).toBe(200);
          const unsubscribeBody = JSON.parse(unsubscribeResult.body);
          expect(unsubscribeBody.email).toBe(email);
        }),
        { numRuns: 20 }
      );
    });

    it("should reject invalid email formats", async () => {
      const invalidEmails = [
        "notanemail",
        "missing@domain",
        "@nodomain.com",
        "spaces in@email.com",
        "",
      ];

      for (const email of invalidEmails) {
        const event = createAPIEvent("POST", "/subscriptions/email", { email });
        const result = await handler(event);
        
        expect(result.statusCode).toBe(400);
        const body = JSON.parse(result.body);
        expect(body.error).toBe("Bad Request");
      }
    });
  });

  /**
   * Property 6: Job Assignment Requires Available Status
   * Requirements: 4.7, 4.8
   * 
   * For any vehicle status that is NOT "available":
   * - Job assignment should be rejected with 400 Bad Request
   */
  describe("Property 6: Job Assignment Requires Available Status", () => {
    const nonAvailableStatuses: VehicleStatus[] = ["en-route", "on-site", "returning", "offline", "idle"];

    it("should reject job assignment for non-available vehicles", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(...nonAvailableStatuses),
          fc.string({ minLength: 1, maxLength: 20 }),
          async (status, vehicleId) => {
            ddbMock.reset();
            locationMock.reset();

            // Mock vehicle exists but is not available
            ddbMock.on(GetCommand).resolves({
              Item: {
                vehicleId: `vehicle-${vehicleId}`,
                status,
                position: { lat: 47.6062, lng: -122.3321 },
              },
            });

            const event = createAPIEvent("POST", "/jobs", {
              address: "123 Main St, Seattle, WA",
              vehicleId: `vehicle-${vehicleId}`,
            });

            const result = await handler(event);

            expect(result.statusCode).toBe(400);
            const body = JSON.parse(result.body);
            expect(body.error).toBe("Bad Request");
            expect(body.message).toContain("not available");
            expect(body.message).toContain(status);
          }
        ),
        { numRuns: 20 }
      );
    });

    it("should accept job assignment for available vehicles", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: {
          vehicleId: "vehicle-001",
          status: "available",
          position: { lat: 47.6062, lng: -122.3321 },
        },
      });
      ddbMock.on(PutCommand).resolves({});

      locationMock.on(SearchPlaceIndexForTextCommand).resolves({
        Results: [{
          Place: {
            Label: "123 Main St, Seattle, WA",
            Geometry: { Point: [-122.3321, 47.6062] },
          },
        }],
      });
      locationMock.on(CalculateRouteCommand).resolves({
        Summary: { DurationSeconds: 600, Distance: 5.0, RouteBBox: [], DataSource: "Esri", DistanceUnit: "Kilometers" },
      });
      locationMock.on(PutGeofenceCommand).resolves({});
      iotMock.on(PublishCommand).resolves({});

      const event = createAPIEvent("POST", "/jobs", {
        address: "123 Main St, Seattle, WA",
        vehicleId: "vehicle-001",
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.jobId).toBeDefined();
      expect(body.vehicleId).toBe("vehicle-001");
    });
  });

  /**
   * Property 7: Geofence Coordinate Validation
   * Requirements: 5.4
   * 
   * For any coordinates:
   * - Latitude must be in range [-90, 90]
   * - Longitude must be in range [-180, 180]
   * - Invalid coordinates should be rejected
   */
  describe("Property 7: Geofence Coordinate Validation", () => {
    // Valid coordinate ranges
    const validLatArb = fc.double({ min: -90, max: 90, noNaN: true });
    const validLngArb = fc.double({ min: -180, max: 180, noNaN: true });

    // Invalid coordinate ranges
    const invalidLatArb = fc.oneof(
      fc.double({ min: -1000, max: -90.001, noNaN: true }),
      fc.double({ min: 90.001, max: 1000, noNaN: true })
    );
    const invalidLngArb = fc.oneof(
      fc.double({ min: -1000, max: -180.001, noNaN: true }),
      fc.double({ min: 180.001, max: 1000, noNaN: true })
    );

    it("should accept valid coordinates from geocoding", async () => {
      await fc.assert(
        fc.asyncProperty(validLatArb, validLngArb, async (lat, lng) => {
          ddbMock.reset();
          locationMock.reset();
          iotMock.reset();

          ddbMock.on(GetCommand).resolves({
            Item: {
              vehicleId: "vehicle-001",
              status: "available",
              position: { lat: 47.6062, lng: -122.3321 },
            },
          });
          ddbMock.on(PutCommand).resolves({});

          locationMock.on(SearchPlaceIndexForTextCommand).resolves({
            Results: [{
              Place: {
                Label: "Test Address",
                Geometry: { Point: [lng, lat] },
              },
            }],
          });
          locationMock.on(CalculateRouteCommand).resolves({
            Summary: { DurationSeconds: 600, Distance: 5.0, RouteBBox: [], DataSource: "Esri", DistanceUnit: "Kilometers" },
          });
          locationMock.on(PutGeofenceCommand).resolves({});
          iotMock.on(PublishCommand).resolves({});

          const event = createAPIEvent("POST", "/jobs", {
            address: "Test Address",
            vehicleId: "vehicle-001",
          });

          const result = await handler(event);

          // Should succeed with valid coordinates
          expect(result.statusCode).toBe(201);
          const body = JSON.parse(result.body);
          expect(body.coordinates.lat).toBeCloseTo(lat, 5);
          expect(body.coordinates.lng).toBeCloseTo(lng, 5);
        }),
        { numRuns: 20 }
      );
    });

    it("should reject invalid latitude from geocoding", async () => {
      await fc.assert(
        fc.asyncProperty(invalidLatArb, validLngArb, async (lat, lng) => {
          ddbMock.reset();
          locationMock.reset();

          ddbMock.on(GetCommand).resolves({
            Item: {
              vehicleId: "vehicle-001",
              status: "available",
              position: { lat: 47.6062, lng: -122.3321 },
            },
          });

          locationMock.on(SearchPlaceIndexForTextCommand).resolves({
            Results: [{
              Place: {
                Label: "Test Address",
                Geometry: { Point: [lng, lat] },
              },
            }],
          });

          const event = createAPIEvent("POST", "/jobs", {
            address: "Test Address",
            vehicleId: "vehicle-001",
          });

          const result = await handler(event);

          expect(result.statusCode).toBe(400);
          const body = JSON.parse(result.body);
          expect(body.message).toContain("latitude");
        }),
        { numRuns: 10 }
      );
    });

    it("should reject invalid longitude from geocoding", async () => {
      await fc.assert(
        fc.asyncProperty(validLatArb, invalidLngArb, async (lat, lng) => {
          ddbMock.reset();
          locationMock.reset();

          ddbMock.on(GetCommand).resolves({
            Item: {
              vehicleId: "vehicle-001",
              status: "available",
              position: { lat: 47.6062, lng: -122.3321 },
            },
          });

          locationMock.on(SearchPlaceIndexForTextCommand).resolves({
            Results: [{
              Place: {
                Label: "Test Address",
                Geometry: { Point: [lng, lat] },
              },
            }],
          });

          const event = createAPIEvent("POST", "/jobs", {
            address: "Test Address",
            vehicleId: "vehicle-001",
          });

          const result = await handler(event);

          expect(result.statusCode).toBe(400);
          const body = JSON.parse(result.body);
          expect(body.message).toContain("longitude");
        }),
        { numRuns: 10 }
      );
    });
  });

  /**
   * Property 8: Geofence Round-Trip
   * Requirements: 5.5
   * 
   * For any valid job creation:
   * - A geofence should be created with the job coordinates
   * - The geofence ID should follow the naming convention
   */
  describe("Property 8: Geofence Round-Trip", () => {
    it("should create geofence with correct coordinates for any valid job", async () => {
      const validLatArb = fc.double({ min: -90, max: 90, noNaN: true });
      const validLngArb = fc.double({ min: -180, max: 180, noNaN: true });

      await fc.assert(
        fc.asyncProperty(validLatArb, validLngArb, async (lat, lng) => {
          ddbMock.reset();
          locationMock.reset();
          iotMock.reset();

          let capturedGeofence: { geofenceId?: string; center?: number[] } = {};

          ddbMock.on(GetCommand).resolves({
            Item: {
              vehicleId: "vehicle-001",
              status: "available",
              position: { lat: 47.6062, lng: -122.3321 },
            },
          });
          ddbMock.on(PutCommand).resolves({});

          locationMock.on(SearchPlaceIndexForTextCommand).resolves({
            Results: [{
              Place: {
                Label: "Test Address",
                Geometry: { Point: [lng, lat] },
              },
            }],
          });
          locationMock.on(CalculateRouteCommand).resolves({
            Summary: { DurationSeconds: 600, Distance: 5.0, RouteBBox: [], DataSource: "Esri", DistanceUnit: "Kilometers" },
          });
          locationMock.on(PutGeofenceCommand).callsFake((input) => {
            capturedGeofence = {
              geofenceId: input.GeofenceId,
              center: input.Geometry?.Circle?.Center,
            };
            return {};
          });
          iotMock.on(PublishCommand).resolves({});

          const event = createAPIEvent("POST", "/jobs", {
            address: "Test Address",
            vehicleId: "vehicle-001",
          });

          const result = await handler(event);

          expect(result.statusCode).toBe(201);
          
          // Verify geofence was created with correct coordinates
          expect(capturedGeofence.center).toBeDefined();
          expect(capturedGeofence.center![0]).toBeCloseTo(lng, 5);
          expect(capturedGeofence.center![1]).toBeCloseTo(lat, 5);
        }),
        { numRuns: 15 }
      );
    });
  });

  /**
   * Property 9: Geofence Naming Convention
   * Requirements: 4.3, 5.2
   * 
   * For any job creation:
   * - Geofence ID should follow pattern "job-{jobId}"
   * - Job ID should be a valid UUID
   */
  describe("Property 9: Geofence Naming Convention", () => {
    it("should create geofence with correct naming convention", async () => {
      let capturedGeofenceId: string | undefined;

      ddbMock.on(GetCommand).resolves({
        Item: {
          vehicleId: "vehicle-001",
          status: "available",
          position: { lat: 47.6062, lng: -122.3321 },
        },
      });
      ddbMock.on(PutCommand).resolves({});

      locationMock.on(SearchPlaceIndexForTextCommand).resolves({
        Results: [{
          Place: {
            Label: "123 Main St",
            Geometry: { Point: [-122.3321, 47.6062] },
          },
        }],
      });
      locationMock.on(CalculateRouteCommand).resolves({
        Summary: { DurationSeconds: 600, Distance: 5.0, RouteBBox: [], DataSource: "Esri", DistanceUnit: "Kilometers" },
      });
      locationMock.on(PutGeofenceCommand).callsFake((input) => {
        capturedGeofenceId = input.GeofenceId;
        return {};
      });
      iotMock.on(PublishCommand).resolves({});

      const event = createAPIEvent("POST", "/jobs", {
        address: "123 Main St",
        vehicleId: "vehicle-001",
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);

      // Verify geofence naming convention
      expect(capturedGeofenceId).toBeDefined();
      expect(capturedGeofenceId).toMatch(/^job-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(capturedGeofenceId).toBe(`job-${body.jobId}`);
      expect(body.geofenceId).toBe(capturedGeofenceId);
    });

    it("should generate unique geofence IDs for multiple jobs", async () => {
      const geofenceIds: string[] = [];

      for (let i = 0; i < 5; i++) {
        ddbMock.reset();
        locationMock.reset();
        iotMock.reset();

        ddbMock.on(GetCommand).resolves({
          Item: {
            vehicleId: `vehicle-00${i}`,
            status: "available",
            position: { lat: 47.6062, lng: -122.3321 },
          },
        });
        ddbMock.on(PutCommand).resolves({});

        locationMock.on(SearchPlaceIndexForTextCommand).resolves({
          Results: [{
            Place: {
              Label: `Address ${i}`,
              Geometry: { Point: [-122.3321, 47.6062] },
            },
          }],
        });
        locationMock.on(CalculateRouteCommand).resolves({
          Summary: { DurationSeconds: 600, Distance: 5.0, RouteBBox: [], DataSource: "Esri", DistanceUnit: "Kilometers" },
        });
        locationMock.on(PutGeofenceCommand).callsFake((input) => {
          geofenceIds.push(input.GeofenceId!);
          return {};
        });
        iotMock.on(PublishCommand).resolves({});

        const event = createAPIEvent("POST", "/jobs", {
          address: `Address ${i}`,
          vehicleId: `vehicle-00${i}`,
        });

        await handler(event);
      }

      // All geofence IDs should be unique
      const uniqueIds = new Set(geofenceIds);
      expect(uniqueIds.size).toBe(geofenceIds.length);
    });
  });
});
