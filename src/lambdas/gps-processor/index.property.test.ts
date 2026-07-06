/**
 * Property-Based Tests for GPS Processor Lambda
 * 
 * Tests universal correctness properties using fast-check library.
 * 
 * Properties tested:
 * - Property 14: Tracker Position Update Structure (Requirements 7.1, 7.2)
 * - Property 15: Tracker Failure Isolation (Requirement 7.4)
 * - Property 16: DynamoDB Independence from Tracker Filtering (Requirement 8.4)
 * - Property 21: GPS Timestamp Preservation (Requirement 11.2)
 * - Property 22: Stale Timestamp Processing (Requirement 11.3)
 * - Property 26: TenantId Preservation on Update (Requirement 12.6)
 */

import * as fc from "fast-check";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { LocationClient, BatchUpdateDevicePositionCommand } from "@aws-sdk/client-location";
import { KinesisStreamEvent, KinesisStreamRecord } from "aws-lambda";

// Set environment variables BEFORE importing handler
process.env.VEHICLE_STATE_TABLE = "vehicle-current-state";
process.env.GPS_HISTORY_TABLE = "gps-history";
process.env.TRACKER_NAME = "fleet-tracker";

// Import handler AFTER setting environment variables
import { handler } from "./index";

// Mock AWS clients
const ddbMock = mockClient(DynamoDBDocumentClient);
const locationMock = mockClient(LocationClient);

// Arbitrary generators for GPS data
const vehicleIdArb = fc.stringMatching(/^vehicle-[0-9]{3}$/);
// Use integer-based coordinates to avoid floating point precision issues
const latitudeArb = fc.integer({ min: -90000000, max: 90000000 }).map(n => n / 1000000);
const longitudeArb = fc.integer({ min: -180000000, max: 180000000 }).map(n => n / 1000000);
const headingArb = fc.integer({ min: 0, max: 359 });
const speedArb = fc.integer({ min: 0, max: 120000 }).map(n => n / 1000);
const ignitionArb = fc.boolean();
// Use integer timestamp to avoid invalid date issues
const timestampArb = fc.integer({ 
  min: new Date("2024-01-01").getTime(), 
  max: new Date("2026-12-31").getTime() 
}).map(ts => new Date(ts).toISOString());

// GPS message arbitrary
const gpsMessageArb = fc.record({
  vehicleId: vehicleIdArb,
  lat: latitudeArb,
  lng: longitudeArb,
  heading: headingArb,
  speed: speedArb,
  ignition: ignitionArb,
  timestamp: timestampArb,
});

// Helper to create Kinesis event from GPS message
function createKinesisEvent(gpsMessage: object): KinesisStreamEvent {
  const payload = Buffer.from(JSON.stringify(gpsMessage)).toString("base64");
  return {
    Records: [
      {
        kinesis: {
          data: payload,
          sequenceNumber: "12345",
          partitionKey: "test",
          kinesisSchemaVersion: "1.0",
          approximateArrivalTimestamp: Date.now() / 1000,
        },
        eventSource: "aws:kinesis",
        eventVersion: "1.0",
        eventID: "shardId-000000000000:12345",
        eventName: "aws:kinesis:record",
        invokeIdentityArn: "arn:aws:iam::123456789012:role/test",
        awsRegion: "us-east-1",
        eventSourceARN: "arn:aws:kinesis:us-east-1:123456789012:stream/test",
      } as KinesisStreamRecord,
    ],
  };
}

describe("GPS Processor Property Tests", () => {
  beforeEach(() => {
    ddbMock.reset();
    locationMock.reset();
    jest.clearAllMocks();
  });

  /**
   * Property 14: Tracker Position Update Structure
   * Requirements: 7.1, 7.2
   * 
   * For any valid GPS message, the tracker update should contain:
   * - DeviceId matching vehicleId
   * - Position as [longitude, latitude] array
   * - SampleTime from the GPS timestamp
   */
  describe("Property 14: Tracker Position Update Structure", () => {
    it("should send position to tracker with correct structure for any valid GPS message", async () => {
      await fc.assert(
        fc.asyncProperty(gpsMessageArb, async (gpsMessage) => {
          ddbMock.reset();
          locationMock.reset();
          ddbMock.on(UpdateCommand).resolves({});
          ddbMock.on(PutCommand).resolves({});
          locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

          const event = createKinesisEvent(gpsMessage);
          await handler(event);

          // Verify tracker was called
          const trackerCalls = locationMock.commandCalls(BatchUpdateDevicePositionCommand);
          expect(trackerCalls.length).toBe(1);

          const trackerInput = trackerCalls[0].args[0].input;
          expect(trackerInput.TrackerName).toBe("fleet-tracker");
          expect(trackerInput.Updates).toHaveLength(1);

          const update = trackerInput.Updates![0];
          // DeviceId should match vehicleId
          expect(update.DeviceId).toBe(gpsMessage.vehicleId);
          // Position should be [longitude, latitude]
          expect(update.Position).toEqual([gpsMessage.lng, gpsMessage.lat]);
          // SampleTime should be a Date object from the timestamp
          expect(update.SampleTime).toEqual(new Date(gpsMessage.timestamp));
        }),
        { numRuns: 50 }
      );
    });
  });

  /**
   * Property 15: Tracker Failure Isolation
   * Requirements: 7.4
   * 
   * For any GPS message, if the tracker API fails, DynamoDB updates should still succeed.
   * The handler should not throw an error.
   */
  describe("Property 15: Tracker Failure Isolation", () => {
    it("should continue DynamoDB updates even when tracker fails", async () => {
      await fc.assert(
        fc.asyncProperty(gpsMessageArb, async (gpsMessage) => {
          ddbMock.reset();
          locationMock.reset();
          ddbMock.on(UpdateCommand).resolves({});
          ddbMock.on(PutCommand).resolves({});
          // Simulate tracker failure
          locationMock.on(BatchUpdateDevicePositionCommand).rejects(new Error("Tracker API error"));

          const event = createKinesisEvent(gpsMessage);
          
          // Handler should NOT throw despite tracker failure
          await expect(handler(event)).resolves.toBeUndefined();

          // DynamoDB should still be updated
          const updateCalls = ddbMock.commandCalls(UpdateCommand);
          const putCalls = ddbMock.commandCalls(PutCommand);
          expect(updateCalls.length).toBe(1); // Vehicle state update
          expect(putCalls.length).toBe(1); // GPS history archive
        }),
        { numRuns: 30 }
      );
    });
  });

  /**
   * Property 16: DynamoDB Independence from Tracker Filtering
   * Requirements: 8.4
   * 
   * For any GPS message, DynamoDB should receive all position updates
   * regardless of whether the tracker filters them out.
   */
  describe("Property 16: DynamoDB Independence from Tracker Filtering", () => {
    it("should update DynamoDB for every GPS message regardless of tracker response", async () => {
      await fc.assert(
        fc.asyncProperty(gpsMessageArb, async (gpsMessage) => {
          ddbMock.reset();
          locationMock.reset();
          ddbMock.on(UpdateCommand).resolves({});
          ddbMock.on(PutCommand).resolves({});
          locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

          const event = createKinesisEvent(gpsMessage);
          await handler(event);

          // Verify DynamoDB was updated with correct data
          const updateCalls = ddbMock.commandCalls(UpdateCommand);
          expect(updateCalls.length).toBe(1);

          const updateInput = updateCalls[0].args[0].input;
          expect(updateInput.Key).toEqual({ vehicleId: gpsMessage.vehicleId });
          expect(updateInput.ExpressionAttributeValues?.[":position"]).toEqual({
            lat: gpsMessage.lat,
            lng: gpsMessage.lng,
          });
          expect(updateInput.ExpressionAttributeValues?.[":lastSeen"]).toBe(gpsMessage.timestamp);

          // Verify GPS history was archived
          const putCalls = ddbMock.commandCalls(PutCommand);
          expect(putCalls.length).toBe(1);
          const putInput = putCalls[0].args[0].input;
          expect(putInput.Item?.vehicleId).toBe(gpsMessage.vehicleId);
          expect(putInput.Item?.timestamp).toBe(gpsMessage.timestamp);
        }),
        { numRuns: 50 }
      );
    });
  });

  /**
   * Property 21: GPS Timestamp Preservation
   * Requirements: 11.2
   * 
   * For any GPS message, the timestamp from the GPS payload should be used
   * for lastSeen, not the processing time.
   */
  describe("Property 21: GPS Timestamp Preservation", () => {
    it("should use GPS payload timestamp for lastSeen, not processing time", async () => {
      await fc.assert(
        fc.asyncProperty(gpsMessageArb, async (gpsMessage) => {
          ddbMock.reset();
          locationMock.reset();
          ddbMock.on(UpdateCommand).resolves({});
          ddbMock.on(PutCommand).resolves({});
          locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

          const event = createKinesisEvent(gpsMessage);
          await handler(event);

          // Verify lastSeen uses GPS timestamp
          const updateCalls = ddbMock.commandCalls(UpdateCommand);
          const updateInput = updateCalls[0].args[0].input;
          expect(updateInput.ExpressionAttributeValues?.[":lastSeen"]).toBe(gpsMessage.timestamp);

          // Verify history record uses GPS timestamp
          const putCalls = ddbMock.commandCalls(PutCommand);
          const putInput = putCalls[0].args[0].input;
          expect(putInput.Item?.timestamp).toBe(gpsMessage.timestamp);
        }),
        { numRuns: 50 }
      );
    });
  });

  /**
   * Property 22: Stale Timestamp Processing
   * Requirements: 11.3
   * 
   * For any GPS message with a stale timestamp (>5 minutes old),
   * the update should still be processed (not rejected).
   */
  describe("Property 22: Stale Timestamp Processing", () => {
    it("should process updates with stale timestamps without rejection", async () => {
      // Generate timestamps that are definitely stale (6-60 minutes old)
      const staleTimestampArb = fc.integer({ min: 6, max: 60 })
        .map(minutes => new Date(Date.now() - minutes * 60 * 1000).toISOString());

      await fc.assert(
        fc.asyncProperty(
          vehicleIdArb,
          latitudeArb,
          longitudeArb,
          headingArb,
          speedArb,
          ignitionArb,
          staleTimestampArb,
          async (vehicleId, lat, lng, heading, speed, ignition, timestamp) => {
            ddbMock.reset();
            locationMock.reset();
            ddbMock.on(UpdateCommand).resolves({});
            ddbMock.on(PutCommand).resolves({});
            locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

            const gpsMessage = { vehicleId, lat, lng, heading, speed, ignition, timestamp };
            const event = createKinesisEvent(gpsMessage);
            
            // Should NOT throw for stale timestamps
            await expect(handler(event)).resolves.toBeUndefined();

            // DynamoDB should still be updated
            const updateCalls = ddbMock.commandCalls(UpdateCommand);
            expect(updateCalls.length).toBe(1);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  /**
   * Property 26: TenantId Preservation on Update
   * Requirements: 12.6
   * 
   * For any GPS update, the UpdateCommand should NOT overwrite tenantId.
   * The update expression should only modify position, heading, speed, ignition, lastSeen, status.
   */
  describe("Property 26: TenantId Preservation on Update", () => {
    it("should not overwrite tenantId in update expression", async () => {
      await fc.assert(
        fc.asyncProperty(gpsMessageArb, async (gpsMessage) => {
          ddbMock.reset();
          locationMock.reset();
          ddbMock.on(UpdateCommand).resolves({});
          ddbMock.on(PutCommand).resolves({});
          locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

          const event = createKinesisEvent(gpsMessage);
          await handler(event);

          // Verify UpdateCommand was called
          const updateCalls = ddbMock.commandCalls(UpdateCommand);
          expect(updateCalls.length).toBe(1);

          const updateInput = updateCalls[0].args[0].input;
          
          // Verify tenantId is NOT in the update expression
          const updateExpression = updateInput.UpdateExpression || "";
          expect(updateExpression).not.toContain("tenantId");
          
          // Verify tenantId is NOT in expression attribute values
          const expressionValues = updateInput.ExpressionAttributeValues || {};
          expect(expressionValues).not.toHaveProperty(":tenantId");
          
          // Verify only expected fields are being updated
          expect(updateExpression).toContain("#position");
          expect(updateExpression).toContain("#heading");
          expect(updateExpression).toContain("#speed");
          expect(updateExpression).toContain("#ignition");
          expect(updateExpression).toContain("#lastSeen");
          expect(updateExpression).toContain("#status");
        }),
        { numRuns: 50 }
      );
    });
  });
});
