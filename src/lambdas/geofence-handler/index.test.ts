// Set environment variables BEFORE importing handler
process.env.DISPATCH_TABLE = "dispatch-assignments";
process.env.VEHICLE_STATE_TABLE = "vehicle-current-state";
process.env.GEOFENCE_COLLECTION_NAME = "job-sites";
process.env.WEBSOCKET_ENDPOINT = "https://test.execute-api.us-west-2.amazonaws.com/v1";
process.env.CONNECTIONS_TABLE = "websocket-connections";
process.env.JOB_COMPLETION_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:fleet-job-completions";

import { EventBridgeEvent, Context } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { LocationClient, BatchDeleteGeofenceCommand } from "@aws-sdk/client-location";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { handler } from "./index";

// Mock AWS clients
const ddbMock = mockClient(DynamoDBDocumentClient);
const locationMock = mockClient(LocationClient);
const snsMock = mockClient(SNSClient);
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

// Helper to create EventBridge event
function createGeofenceEvent(
  eventType: "ENTER" | "EXIT",
  geofenceId: string,
  deviceId: string
): EventBridgeEvent<"Location Geofence Event", any> {
  return {
    version: "0",
    id: "test-event-id",
    "detail-type": "Location Geofence Event",
    source: "aws.geo",
    account: "123456789012",
    time: "2024-03-15T10:30:00Z",
    region: "us-west-2",
    resources: [],
    detail: {
      EventType: eventType,
      GeofenceId: geofenceId,
      DeviceId: deviceId,
      Position: [-122.4194, 37.7749],
      SampleTime: "2024-03-15T10:30:00Z",
      GeofenceCollection: "job-sites",
    },
  };
}

describe("Geofence Handler Lambda", () => {
  beforeEach(() => {
    ddbMock.reset();
    locationMock.reset();
    snsMock.reset();
    cloudWatchMock.reset();
    apiGatewayMock.reset();
    jest.clearAllMocks();
  });

  describe("job completion flow", () => {
    it("should complete job when vehicle enters geofence", async () => {
      // Mock GetCommand to return existing job
      ddbMock.on(GetCommand).resolves({ 
        Item: { status: "en-route", tenantId: "tenant-1", address: "123 Main St" } 
      });
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(ScanCommand).resolves({ Items: [] });
      locationMock.on(BatchDeleteGeofenceCommand).resolves({});
      snsMock.on(PublishCommand).resolves({});
      cloudWatchMock.on(PutMetricDataCommand).resolves({});

      const event = createGeofenceEvent("ENTER", "job-12345", "vehicle-001");

      await expect(handler(event, mockContext)).resolves.toBeUndefined();

      // Verify UpdateCommand was called at least twice (dispatch + vehicle)
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls.length).toBeGreaterThanOrEqual(2);

      // Verify dispatch assignment was updated with correct key
      const dispatchUpdate = updateCalls.find(
        (call: any) => call.args[0].input.Key?.jobId === "12345"
      );
      expect(dispatchUpdate).toBeDefined();
      expect(dispatchUpdate!.args[0].input.Key).toEqual({
        jobId: "12345",
        vehicleId: "vehicle-001",
      });
    });

    it("should update vehicle status to returning", async () => {
      ddbMock.on(GetCommand).resolves({ 
        Item: { status: "en-route", tenantId: "tenant-1", address: "123 Main St" } 
      });
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(ScanCommand).resolves({ Items: [] });
      locationMock.on(BatchDeleteGeofenceCommand).resolves({});
      snsMock.on(PublishCommand).resolves({});
      cloudWatchMock.on(PutMetricDataCommand).resolves({});

      const event = createGeofenceEvent("ENTER", "job-12345", "vehicle-001");

      await handler(event, mockContext);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      const vehicleUpdate = updateCalls.find(
        (call: any) => call.args[0].input.Key?.vehicleId === "vehicle-001" && !call.args[0].input.Key?.jobId
      );

      expect(vehicleUpdate).toBeDefined();
      expect(vehicleUpdate!.args[0].input.Key).toEqual({ vehicleId: "vehicle-001" });
      expect(vehicleUpdate!.args[0].input.ExpressionAttributeValues?.[":status"]).toBe("returning");
    });

    it("should delete geofence after job completion", async () => {
      ddbMock.on(GetCommand).resolves({ 
        Item: { status: "en-route", tenantId: "tenant-1", address: "123 Main St" } 
      });
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(ScanCommand).resolves({ Items: [] });
      locationMock.on(BatchDeleteGeofenceCommand).resolves({});
      snsMock.on(PublishCommand).resolves({});
      cloudWatchMock.on(PutMetricDataCommand).resolves({});

      const event = createGeofenceEvent("ENTER", "job-12345", "vehicle-001");

      await handler(event, mockContext);

      const deleteCalls = locationMock.commandCalls(BatchDeleteGeofenceCommand);
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0].args[0].input.GeofenceIds).toEqual(["job-12345"]);
    });
  });

  describe("home base return flow", () => {
    it("should update vehicle to available when returning vehicle enters home base", async () => {
      ddbMock.on(GetCommand).resolves({ 
        Item: { status: "returning", tenantId: "tenant-1" } 
      });
      ddbMock.on(UpdateCommand).resolves({});

      const event = createGeofenceEvent("ENTER", "home-vehicle-001", "vehicle-001");

      await handler(event, mockContext);

      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0].args[0].input.ExpressionAttributeValues?.[":status"]).toBe("available");
    });

    it("should ignore home base entry for available vehicle", async () => {
      ddbMock.on(GetCommand).resolves({ 
        Item: { status: "available", tenantId: "tenant-1" } 
      });

      const event = createGeofenceEvent("ENTER", "home-vehicle-001", "vehicle-001");

      await handler(event, mockContext);

      // No update should be made
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(0);
    });

    it("should NOT delete home base geofence", async () => {
      ddbMock.on(GetCommand).resolves({ 
        Item: { status: "returning", tenantId: "tenant-1" } 
      });
      ddbMock.on(UpdateCommand).resolves({});

      const event = createGeofenceEvent("ENTER", "home-vehicle-001", "vehicle-001");

      await handler(event, mockContext);

      // No geofence deletion should occur
      const deleteCalls = locationMock.commandCalls(BatchDeleteGeofenceCommand);
      expect(deleteCalls).toHaveLength(0);
    });
  });

  describe("non-existent job handling", () => {
    it("should handle non-existent job gracefully", async () => {
      // Mock GetCommand to return no item (job doesn't exist)
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = createGeofenceEvent("ENTER", "job-nonexistent", "vehicle-001");

      // Should not throw
      await expect(handler(event, mockContext)).resolves.toBeUndefined();

      // No updates should be made
      const updateCalls = ddbMock.commandCalls(UpdateCommand);
      expect(updateCalls).toHaveLength(0);
    });
  });

  describe("event filtering", () => {
    it("should ignore EXIT events", async () => {
      const event = createGeofenceEvent("EXIT", "job-12345", "vehicle-001");

      await handler(event, mockContext);

      // No DynamoDB or Location calls should be made
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(locationMock.commandCalls(BatchDeleteGeofenceCommand)).toHaveLength(0);
    });

    it("should ignore geofences without job- prefix", async () => {
      const event = createGeofenceEvent("ENTER", "other-geofence", "vehicle-001");

      await handler(event, mockContext);

      // No DynamoDB or Location calls should be made
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
      expect(locationMock.commandCalls(BatchDeleteGeofenceCommand)).toHaveLength(0);
    });
  });

  describe("WebSocket broadcast", () => {
    it("should broadcast job completion to connected clients", async () => {
      ddbMock.on(GetCommand).resolves({ 
        Item: { status: "en-route", tenantId: "tenant-1", address: "123 Main St" } 
      });
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(ScanCommand).resolves({
        Items: [{ connectionId: "conn-1" }, { connectionId: "conn-2" }],
      });
      locationMock.on(BatchDeleteGeofenceCommand).resolves({});
      snsMock.on(PublishCommand).resolves({});
      cloudWatchMock.on(PutMetricDataCommand).resolves({});
      apiGatewayMock.on(PostToConnectionCommand).resolves({});

      const event = createGeofenceEvent("ENTER", "job-12345", "vehicle-001");

      await handler(event, mockContext);

      // Verify WebSocket broadcast was attempted
      const postCalls = apiGatewayMock.commandCalls(PostToConnectionCommand);
      expect(postCalls.length).toBeGreaterThanOrEqual(1);
    });

    it("should handle stale connections gracefully", async () => {
      ddbMock.on(GetCommand).resolves({ 
        Item: { status: "en-route", tenantId: "tenant-1", address: "123 Main St" } 
      });
      ddbMock.on(UpdateCommand).resolves({});
      ddbMock.on(ScanCommand).resolves({
        Items: [{ connectionId: "stale-conn" }],
      });
      locationMock.on(BatchDeleteGeofenceCommand).resolves({});
      snsMock.on(PublishCommand).resolves({});
      cloudWatchMock.on(PutMetricDataCommand).resolves({});

      const staleError = new Error("Gone");
      (staleError as any).statusCode = 410;
      apiGatewayMock.on(PostToConnectionCommand).rejects(staleError);

      const event = createGeofenceEvent("ENTER", "job-12345", "vehicle-001");

      // Should not throw despite stale connection
      await expect(handler(event, mockContext)).resolves.toBeUndefined();
    });
  });

  describe("error handling", () => {
    it("should throw error when DynamoDB update fails", async () => {
      ddbMock.on(GetCommand).resolves({ 
        Item: { status: "en-route", tenantId: "tenant-1", address: "123 Main St" } 
      });
      ddbMock.on(UpdateCommand).rejects(new Error("DynamoDB error"));

      const event = createGeofenceEvent("ENTER", "job-12345", "vehicle-001");

      await expect(handler(event, mockContext)).rejects.toThrow("DynamoDB error");
    });

    it("should throw error when geofence deletion fails", async () => {
      ddbMock.on(GetCommand).resolves({ 
        Item: { status: "en-route", tenantId: "tenant-1", address: "123 Main St" } 
      });
      ddbMock.on(UpdateCommand).resolves({});
      locationMock.on(BatchDeleteGeofenceCommand).rejects(new Error("Location error"));

      const event = createGeofenceEvent("ENTER", "job-12345", "vehicle-001");

      await expect(handler(event, mockContext)).rejects.toThrow("Location error");
    });
  });
});
