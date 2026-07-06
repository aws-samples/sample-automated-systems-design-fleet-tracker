import { KinesisStreamEvent, KinesisStreamRecord } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { LocationClient, BatchUpdateDevicePositionCommand } from "@aws-sdk/client-location";

// Set environment variables BEFORE importing handler
process.env.VEHICLE_STATE_TABLE = "vehicle-current-state";
process.env.GPS_HISTORY_TABLE = "gps-history";
process.env.TRACKER_NAME = "fleet-tracker";

// Import handler AFTER setting environment variables
import { handler } from "./index";

// Mock AWS clients
const ddbMock = mockClient(DynamoDBDocumentClient);
const locationMock = mockClient(LocationClient);

// Helper to create a Kinesis record
function createKinesisRecord(gpsMessage: object): KinesisStreamRecord {
  const data = Buffer.from(JSON.stringify(gpsMessage)).toString("base64");
  return {
    kinesis: {
      kinesisSchemaVersion: "1.0",
      partitionKey: "vehicle-001",
      sequenceNumber: "12345",
      data,
      approximateArrivalTimestamp: Date.now() / 1000,
    },
    eventSource: "aws:kinesis",
    eventVersion: "1.0",
    eventID: "shardId-000000000000:12345",
    eventName: "aws:kinesis:record",
    invokeIdentityArn: "arn:aws:iam::123456789012:role/test",
    awsRegion: "us-west-2",
    eventSourceARN: "arn:aws:kinesis:us-west-2:123456789012:stream/fleet-gps-stream",
  };
}

// Sample GPS message
const sampleGpsMessage = {
  vehicleId: "vehicle-001",
  timestamp: "2024-03-15T10:30:00Z",
  lat: 37.7749,
  lng: -122.4194,
  speed: 35.5,
  heading: 180,
  ignition: true,
};

describe("GPS Processor Lambda", () => {
  beforeEach(() => {
    ddbMock.reset();
    locationMock.reset();
    jest.clearAllMocks();
  });

  describe("batch processing", () => {
    it("should process a single GPS record successfully", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(sampleGpsMessage)],
      };

      await expect(handler(event)).resolves.toBeUndefined();

      // Verify UpdateCommand was called for vehicle state
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input.Key).toEqual({ vehicleId: "vehicle-001" });

      // Verify PutCommand was called for history
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
    });

    it("should process multiple GPS records in batch", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const messages = [
        { ...sampleGpsMessage, vehicleId: "vehicle-001" },
        { ...sampleGpsMessage, vehicleId: "vehicle-002" },
        { ...sampleGpsMessage, vehicleId: "vehicle-003" },
      ];

      const event: KinesisStreamEvent = {
        Records: messages.map(createKinesisRecord),
      };

      await expect(handler(event)).resolves.toBeUndefined();

      // Should have 3 update calls and 3 put calls
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(3);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(3);
    });

    it("should throw error when any record fails", async () => {
      ddbMock.on(UpdateCommand).rejectsOnce(new Error("DynamoDB error")).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const event: KinesisStreamEvent = {
        Records: [
          createKinesisRecord({ ...sampleGpsMessage, vehicleId: "vehicle-001" }),
          createKinesisRecord({ ...sampleGpsMessage, vehicleId: "vehicle-002" }),
        ],
      };

      await expect(handler(event)).rejects.toThrow("Failed to process 1 of 2 records");
    });
  });

  describe("DynamoDB upsert operations", () => {
    it("should update vehicle state with correct position data", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(sampleGpsMessage)],
      };

      await handler(event);

      const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
      const input = updateCall.args[0].input;

      expect(input.ExpressionAttributeValues).toMatchObject({
        ":position": { lat: 37.7749, lng: -122.4194 },
        ":heading": 180,
        ":speed": 35.5,
        ":ignition": true,
      });
    });

    it("should archive GPS history with TTL", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(sampleGpsMessage)],
      };

      await handler(event);

      const putCall = ddbMock.commandCalls(PutCommand)[0];
      const item = putCall.args[0].input.Item;

      expect(item).toBeDefined();
      expect(item).toMatchObject({
        vehicleId: "vehicle-001",
        timestamp: "2024-03-15T10:30:00Z",
        position: { lat: 37.7749, lng: -122.4194 },
        heading: 180,
        speed: 35.5,
        ignition: true,
      });

      // TTL should be approximately 24 hours from now
      const expectedTtl = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
      expect(item!.ttl).toBeGreaterThan(expectedTtl - 10);
      expect(item!.ttl).toBeLessThan(expectedTtl + 10);
    });

    it("should handle conditional check failure for en-route vehicles", async () => {
      const conditionalError = new Error("Conditional check failed");
      conditionalError.name = "ConditionalCheckFailedException";

      ddbMock
        .on(UpdateCommand)
        .rejectsOnce(conditionalError)
        .resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(sampleGpsMessage)],
      };

      // Should not throw - should retry without status update
      await expect(handler(event)).resolves.toBeUndefined();

      // Should have called UpdateCommand twice (initial + retry)
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
    });
  });

  describe("vehicle status determination", () => {
    it("should set status to offline when ignition is off", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const offlineMessage = { ...sampleGpsMessage, ignition: false, speed: 0 };
      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(offlineMessage)],
      };

      await handler(event);

      const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
      expect(updateCall.args[0].input.ExpressionAttributeValues?.[":status"]).toBe("offline");
    });

    it("should set status to idle when ignition on but speed is 0", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const idleMessage = { ...sampleGpsMessage, ignition: true, speed: 0 };
      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(idleMessage)],
      };

      await handler(event);

      const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
      expect(updateCall.args[0].input.ExpressionAttributeValues?.[":status"]).toBe("idle");
    });

    it("should set status to available when moving", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const movingMessage = { ...sampleGpsMessage, ignition: true, speed: 35 };
      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(movingMessage)],
      };

      await handler(event);

      const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
      expect(updateCall.args[0].input.ExpressionAttributeValues?.[":status"]).toBe("available");
    });
  });

  // Task 9.7: Unit tests for GPS processor enhancements
  describe("tracker integration (Task 8.2)", () => {
    it("should send position to tracker with correct format", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(sampleGpsMessage)],
      };

      await handler(event);

      // Verify tracker was called
      const trackerCalls = locationMock.commandCalls(BatchUpdateDevicePositionCommand);
      expect(trackerCalls).toHaveLength(1);

      const trackerInput = trackerCalls[0].args[0].input;
      expect(trackerInput.TrackerName).toBe("fleet-tracker");
      expect(trackerInput.Updates).toHaveLength(1);
      expect(trackerInput.Updates![0].DeviceId).toBe("vehicle-001");
      expect(trackerInput.Updates![0].Position).toEqual([-122.4194, 37.7749]); // [lng, lat]
    });

    it("should continue processing when tracker fails", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).rejects(new Error("Tracker API error"));

      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(sampleGpsMessage)],
      };

      // Should NOT throw despite tracker failure
      await expect(handler(event)).resolves.toBeUndefined();

      // DynamoDB should still be updated
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    });
  });

  describe("stale timestamp handling (Task 9.3)", () => {
    it("should process stale timestamps without rejection", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      // Create a message with a timestamp 10 minutes old
      const staleTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const staleMessage = { ...sampleGpsMessage, timestamp: staleTimestamp };
      
      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(staleMessage)],
      };

      // Should NOT throw for stale timestamps
      await expect(handler(event)).resolves.toBeUndefined();

      // DynamoDB should still be updated
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
    });
  });

  describe("timestamp preservation (Task 9.1)", () => {
    it("should use GPS payload timestamp for lastSeen", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(sampleGpsMessage)],
      };

      await handler(event);

      const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
      expect(updateCall.args[0].input.ExpressionAttributeValues?.[":lastSeen"]).toBe("2024-03-15T10:30:00Z");
    });
  });

  describe("tenantId preservation (Task 9.5)", () => {
    it("should not overwrite tenantId in update expression", async () => {
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(PutCommand).resolves({});
      locationMock.on(BatchUpdateDevicePositionCommand).resolves({});

      const event: KinesisStreamEvent = {
        Records: [createKinesisRecord(sampleGpsMessage)],
      };

      await handler(event);

      const updateCall = ddbMock.commandCalls(UpdateCommand)[0];
      const updateExpression = updateCall.args[0].input.UpdateExpression || "";
      
      // tenantId should NOT be in the update expression
      expect(updateExpression).not.toContain("tenantId");
    });
  });
});
