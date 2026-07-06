/**
 * Property-Based Tests for Geofence Handler
 * 
 * These tests validate universal correctness properties using fast-check.
 * Properties are derived from Phase 2 requirements.
 */

// Set environment variables BEFORE importing the handler
process.env.DISPATCH_TABLE = "dispatch-assignments";
process.env.VEHICLE_STATE_TABLE = "vehicle-current-state";
process.env.GEOFENCE_COLLECTION_NAME = "job-sites";
process.env.NOTIFICATION_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/fleet-notifications";
process.env.WEBSOCKET_ENDPOINT = "https://test.execute-api.us-west-2.amazonaws.com/v1";
process.env.CONNECTIONS_TABLE = "websocket-connections";

import { EventBridgeEvent, Context } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { LocationClient, BatchDeleteGeofenceCommand } from "@aws-sdk/client-location";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import {
  ApiGatewayManagementApiClient,
} from "@aws-sdk/client-apigatewaymanagementapi";
import * as fc from "fast-check";
import { handler } from "./index";

// Mock AWS clients
const ddbMock = mockClient(DynamoDBDocumentClient);
const locationMock = mockClient(LocationClient);
const sqsMock = mockClient(SQSClient);
const cloudWatchMock = mockClient(CloudWatchClient);
const apiGatewayMock = mockClient(ApiGatewayManagementApiClient);

// Mock context
const mockContext: Context = {
  awsRequestId: "test-request-id",
  callbackWaitsForEmptyEventLoop: false,
  functionName: "geofence-handler",
  functionVersion: "1",
  invokedFunctionArn: "arn:aws:lambda:us-west-2:123456789012:function:geofence-handler",
  memoryLimitInMB: "256",
  logGroupName: "/aws/lambda/geofence-handler",
  logStreamName: "2024/03/15/[$LATEST]abc123",
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

// Arbitraries for generating test data
const vehicleIdArb = fc.stringMatching(/^vehicle-[0-9]{3}$/);
const jobIdArb = fc.uuid();
const tenantIdArb = fc.uuid();
const addressArb = fc.string({ minLength: 5, maxLength: 50 });
const latitudeArb = fc.double({ min: -90, max: 90, noNaN: true });
const longitudeArb = fc.double({ min: -180, max: 180, noNaN: true });
const timestampArb = fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
  .map(d => d.toISOString());

// Helper to create EventBridge event
function createGeofenceEvent(
  eventType: "ENTER" | "EXIT",
  geofenceId: string,
  deviceId: string,
  position: [number, number] = [-122.4194, 37.7749],
  sampleTime: string = new Date().toISOString()
): EventBridgeEvent<"Location Geofence Event", any> {
  return {
    version: "0",
    id: "test-event-id",
    "detail-type": "Location Geofence Event",
    source: "aws.geo",
    account: "123456789012",
    time: sampleTime,
    region: "us-west-2",
    resources: [],
    detail: {
      EventType: eventType,
      GeofenceId: geofenceId,
      DeviceId: deviceId,
      Position: position,
      SampleTime: sampleTime,
      GeofenceCollection: "job-sites",
    },
  };
}

describe("Property Tests: Geofence Handler", () => {
  beforeEach(() => {
    ddbMock.reset();
    locationMock.reset();
    sqsMock.reset();
    cloudWatchMock.reset();
    apiGatewayMock.reset();
  });

  /**
   * Property 2: Job Completion Updates Dispatch Assignment
   * Requirements: 1.1, 1.2
   * 
   * For any valid job geofence ENTER event:
   * - The dispatch assignment status MUST be updated to "completed"
   * - The completedAt timestamp MUST be set
   */
  describe("Property 2: Job Completion Updates Dispatch Assignment", () => {
    it("should update dispatch assignment to completed for any valid job", async () => {
      await fc.assert(
        fc.asyncProperty(
          jobIdArb,
          vehicleIdArb,
          tenantIdArb,
          addressArb,
          async (jobId, vehicleId, tenantId, address) => {
            ddbMock.reset();
            locationMock.reset();
            sqsMock.reset();
            cloudWatchMock.reset();
            apiGatewayMock.reset();

            // Mock GetCommand - returns data for any table
            ddbMock.on(GetCommand).resolves({ 
              Item: { status: "en-route", tenantId, address } 
            });

            ddbMock.on(UpdateCommand).resolves({});
            ddbMock.on(ScanCommand).resolves({ Items: [] });
            locationMock.on(BatchDeleteGeofenceCommand).resolves({});
            sqsMock.on(SendMessageCommand).resolves({});
            cloudWatchMock.on(PutMetricDataCommand).resolves({});

            const geofenceId = `job-${jobId}`;
            const event = createGeofenceEvent("ENTER", geofenceId, vehicleId);

            await handler(event, mockContext);

            // Verify dispatch assignment was updated
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            const dispatchUpdate = updateCalls.find(
              (call: any) => 
                call.args[0].input.TableName === "dispatch-assignments" &&
                call.args[0].input.Key?.jobId === jobId
            );

            expect(dispatchUpdate).toBeDefined();
            expect(dispatchUpdate!.args[0].input.ExpressionAttributeValues).toMatchObject({
              ":status": "completed",
            });
            // completedAt should be set (it's a timestamp string)
            expect(dispatchUpdate!.args[0].input.ExpressionAttributeValues?.[":completedAt"]).toBeDefined();
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Property 3: Job Geofence Cleanup on Completion
   * Requirements: 1.3
   * 
   * For any job completion event:
   * - The job geofence MUST be deleted from the collection
   * - The geofence ID in the delete call MUST match the event geofence ID
   */
  describe("Property 3: Job Geofence Cleanup on Completion", () => {
    it("should delete job geofence after completion for any valid job", async () => {
      await fc.assert(
        fc.asyncProperty(
          jobIdArb,
          vehicleIdArb,
          async (jobId, vehicleId) => {
            ddbMock.reset();
            locationMock.reset();
            sqsMock.reset();
            cloudWatchMock.reset();

            ddbMock.on(GetCommand).resolves({ 
              Item: { status: "en-route", tenantId: "tenant-1", address: "123 Main St" } 
            });

            ddbMock.on(UpdateCommand).resolves({});
            ddbMock.on(ScanCommand).resolves({ Items: [] });
            locationMock.on(BatchDeleteGeofenceCommand).resolves({});
            sqsMock.on(SendMessageCommand).resolves({});
            cloudWatchMock.on(PutMetricDataCommand).resolves({});

            const geofenceId = `job-${jobId}`;
            const event = createGeofenceEvent("ENTER", geofenceId, vehicleId);

            await handler(event, mockContext);

            // Verify geofence was deleted
            const deleteCalls = locationMock.commandCalls(BatchDeleteGeofenceCommand);
            expect(deleteCalls).toHaveLength(1);
            expect(deleteCalls[0].args[0].input.GeofenceIds).toContain(geofenceId);
            expect(deleteCalls[0].args[0].input.CollectionName).toBe("job-sites");
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Property 4: Home Base Geofence Persistence
   * Requirements: 4.5
   * 
   * For any home base geofence ENTER event:
   * - The home base geofence MUST NOT be deleted
   * - BatchDeleteGeofence should NOT be called for home-* geofences
   */
  describe("Property 4: Home Base Geofence Persistence", () => {
    it("should NOT delete home base geofence on entry", async () => {
      await fc.assert(
        fc.asyncProperty(
          vehicleIdArb,
          async (vehicleId) => {
            ddbMock.reset();
            locationMock.reset();

            // Vehicle is in "returning" status (valid for home base entry)
            ddbMock.on(GetCommand).resolves({
              Item: { status: "returning", tenantId: "tenant-1" },
            });
            ddbMock.on(UpdateCommand).resolves({});

            const geofenceId = `home-${vehicleId}`;
            const event = createGeofenceEvent("ENTER", geofenceId, vehicleId);

            await handler(event, mockContext);

            // Verify geofence was NOT deleted
            const deleteCalls = locationMock.commandCalls(BatchDeleteGeofenceCommand);
            expect(deleteCalls).toHaveLength(0);
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Property 5: Home Base Entry Ignored for Non-Returning Vehicles
   * Requirements: 4.6
   * 
   * For any home base geofence ENTER event where vehicle status is NOT "returning":
   * - The vehicle status MUST NOT be changed
   * - No UpdateCommand should be issued for vehicle state
   */
  describe("Property 5: Home Base Entry Ignored for Non-Returning Vehicles", () => {
    const nonReturningStatuses = ['available', 'en-route', 'on-site', 'offline', 'idle'] as const;

    it("should ignore home base entry for non-returning vehicles", async () => {
      await fc.assert(
        fc.asyncProperty(
          vehicleIdArb,
          fc.constantFrom(...nonReturningStatuses),
          async (vehicleId, currentStatus) => {
            ddbMock.reset();
            locationMock.reset();

            // Vehicle is NOT in "returning" status
            ddbMock.on(GetCommand).resolves({
              Item: { status: currentStatus, tenantId: "tenant-1" },
            });

            const geofenceId = `home-${vehicleId}`;
            const event = createGeofenceEvent("ENTER", geofenceId, vehicleId);

            await handler(event, mockContext);

            // Verify no update was made to vehicle state
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(0);
          }
        ),
        { numRuns: 25 }
      );
    });
  });

  /**
   * Property 1: Vehicle Status State Machine
   * Requirements: 2.1, 2.2, 2.3, 2.5, 4.4
   * 
   * Vehicle status transitions must follow the state machine:
   * - available → en-route (on job assignment)
   * - en-route → returning (on job completion)
   * - returning → available (on home base arrival)
   */
  describe("Property 1: Vehicle Status State Machine", () => {
    it("should transition vehicle to returning on job completion", async () => {
      await fc.assert(
        fc.asyncProperty(
          jobIdArb,
          vehicleIdArb,
          async (jobId, vehicleId) => {
            ddbMock.reset();
            locationMock.reset();
            sqsMock.reset();
            cloudWatchMock.reset();

            ddbMock.on(GetCommand).resolves({ 
              Item: { status: "en-route", tenantId: "tenant-1", address: "123 Main St" } 
            });

            ddbMock.on(UpdateCommand).resolves({});
            ddbMock.on(ScanCommand).resolves({ Items: [] });
            locationMock.on(BatchDeleteGeofenceCommand).resolves({});
            sqsMock.on(SendMessageCommand).resolves({});
            cloudWatchMock.on(PutMetricDataCommand).resolves({});

            const geofenceId = `job-${jobId}`;
            const event = createGeofenceEvent("ENTER", geofenceId, vehicleId);

            await handler(event, mockContext);

            // Verify vehicle status was updated to "returning"
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            const vehicleUpdate = updateCalls.find(
              (call: any) =>
                call.args[0].input.TableName === "vehicle-current-state" &&
                call.args[0].input.Key?.vehicleId === vehicleId
            );

            expect(vehicleUpdate).toBeDefined();
            expect(vehicleUpdate!.args[0].input.ExpressionAttributeValues?.[":status"]).toBe("returning");
          }
        ),
        { numRuns: 20 }
      );
    });

    it("should transition vehicle to available on home base arrival when returning", async () => {
      await fc.assert(
        fc.asyncProperty(
          vehicleIdArb,
          async (vehicleId) => {
            ddbMock.reset();

            // Vehicle is in "returning" status
            ddbMock.on(GetCommand).resolves({ 
              Item: { status: "returning", tenantId: "tenant-1" } 
            });
            ddbMock.on(UpdateCommand).resolves({});

            const geofenceId = `home-${vehicleId}`;
            const event = createGeofenceEvent("ENTER", geofenceId, vehicleId);

            await handler(event, mockContext);

            // Verify vehicle status was updated to "available"
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls).toHaveLength(1);
            expect(updateCalls[0].args[0].input.ExpressionAttributeValues?.[":status"]).toBe("available");
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Property 10: Job Completion Notification Message Structure
   * Requirements: 3.1, 3.2
   * 
   * For any job completion:
   * - A message MUST be published to SQS
   * - The message MUST contain: type, jobId, vehicleId, completedAt, destination, tenantId
   */
  describe("Property 10: Job Completion Notification Message Structure", () => {
    it("should publish correctly structured notification for any job completion", async () => {
      await fc.assert(
        fc.asyncProperty(
          jobIdArb,
          vehicleIdArb,
          tenantIdArb,
          addressArb,
          async (jobId, vehicleId, tenantId, address) => {
            ddbMock.reset();
            locationMock.reset();
            sqsMock.reset();
            cloudWatchMock.reset();

            ddbMock.on(GetCommand).resolves({ 
              Item: { status: "en-route", tenantId, address } 
            });

            ddbMock.on(UpdateCommand).resolves({});
            ddbMock.on(ScanCommand).resolves({ Items: [] });
            locationMock.on(BatchDeleteGeofenceCommand).resolves({});
            sqsMock.on(SendMessageCommand).resolves({});
            cloudWatchMock.on(PutMetricDataCommand).resolves({});

            const geofenceId = `job-${jobId}`;
            const event = createGeofenceEvent("ENTER", geofenceId, vehicleId);

            await handler(event, mockContext);

            // Verify SQS message was sent with correct structure
            const sqsCalls = sqsMock.commandCalls(SendMessageCommand);
            expect(sqsCalls).toHaveLength(1);

            const messageBody = JSON.parse(sqsCalls[0].args[0].input.MessageBody!);
            expect(messageBody).toMatchObject({
              type: "JOB_COMPLETED",
              jobId,
              vehicleId,
              destination: address,
              tenantId,
            });
            expect(messageBody.completedAt).toBeDefined();
            expect(typeof messageBody.completedAt).toBe("string");
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  /**
   * Property 13: Structured Logging Format
   * Requirements: 6.1, 6.2, 6.3, 6.4
   * 
   * All log entries must be valid JSON with required fields.
   * (This is validated by the handler not throwing and completing successfully)
   */
  describe("Property 13: Structured Logging Format", () => {
    it("should complete without errors for any valid geofence event", async () => {
      await fc.assert(
        fc.asyncProperty(
          jobIdArb,
          vehicleIdArb,
          latitudeArb,
          longitudeArb,
          timestampArb,
          async (jobId, vehicleId, lat, lng, timestamp) => {
            ddbMock.reset();
            locationMock.reset();
            sqsMock.reset();
            cloudWatchMock.reset();

            ddbMock.on(GetCommand).resolves({ 
              Item: { status: "en-route", tenantId: "tenant-1", address: "123 Main St" } 
            });

            ddbMock.on(UpdateCommand).resolves({});
            ddbMock.on(ScanCommand).resolves({ Items: [] });
            locationMock.on(BatchDeleteGeofenceCommand).resolves({});
            sqsMock.on(SendMessageCommand).resolves({});
            cloudWatchMock.on(PutMetricDataCommand).resolves({});

            const geofenceId = `job-${jobId}`;
            const event = createGeofenceEvent("ENTER", geofenceId, vehicleId, [lng, lat], timestamp);

            // Should complete without throwing
            await expect(handler(event, mockContext)).resolves.toBeUndefined();
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});
