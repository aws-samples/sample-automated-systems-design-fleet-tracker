/**
 * Unit Tests for WebSocket Broadcast Lambda
 * 
 * Tests tenant-filtered WebSocket broadcasts
 * Task 14.5, 14.6, 14.7: Tenant-scoped WebSocket broadcasts
 * Requirements: 13.4, 13.5
 */

import { DynamoDBStreamEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand, GoneException } from "@aws-sdk/client-apigatewaymanagementapi";

// Set environment variables BEFORE importing handler
process.env.CONNECTIONS_TABLE = "websocket-connections";
process.env.WEBSOCKET_ENDPOINT = "https://test.execute-api.us-east-1.amazonaws.com/v1";

// Import handler AFTER setting environment variables
import { handler } from "./index";

// Mock AWS clients
const ddbMock = mockClient(DynamoDBDocumentClient);
const apiGwMock = mockClient(ApiGatewayManagementApiClient);

// Helper to create DynamoDB Stream event
function createStreamEvent(records: Array<{
  vehicleId: string;
  tenantId?: string;
  position: { lat: number; lng: number };
  status: string;
}>): DynamoDBStreamEvent {
  return {
    Records: records.map((record, index) => {
      const newImage: Record<string, any> = {
        vehicleId: { S: record.vehicleId },
        position: { M: { lat: { N: String(record.position.lat) }, lng: { N: String(record.position.lng) } } },
        heading: { N: "180" },
        speed: { N: "35" },
        status: { S: record.status },
        ignition: { BOOL: true },
      };
      
      if (record.tenantId) {
        newImage.tenantId = { S: record.tenantId };
      }
      
      return {
        eventID: `event-${index}`,
        eventName: "MODIFY" as const,
        eventVersion: "1.1",
        eventSource: "aws:dynamodb",
        awsRegion: "us-east-1",
        dynamodb: {
          Keys: {
            vehicleId: { S: record.vehicleId },
          },
          NewImage: newImage,
          StreamViewType: "NEW_IMAGE",
          SequenceNumber: `${index}`,
          SizeBytes: 100,
        },
        eventSourceARN: "arn:aws:dynamodb:us-east-1:123456789012:table/vehicle-current-state/stream/2024-01-01T00:00:00.000",
      };
    }),
  };
}

describe("WebSocket Broadcast Lambda", () => {
  beforeEach(() => {
    ddbMock.reset();
    apiGwMock.reset();
    jest.clearAllMocks();
  });

  describe("Tenant-Filtered Broadcasts (Task 14.5)", () => {
    it("should broadcast updates only to connections with matching tenantId", async () => {
      // Setup: Two tenants with different connections
      const connections = [
        { connectionId: "conn-1", tenantId: "tenant-a" },
        { connectionId: "conn-2", tenantId: "tenant-a" },
        { connectionId: "conn-3", tenantId: "tenant-b" },
      ];
      ddbMock.on(ScanCommand).resolves({ Items: connections });
      apiGwMock.on(PostToConnectionCommand).resolves({});

      // Vehicle update for tenant-a
      const event = createStreamEvent([
        { vehicleId: "vehicle-001", tenantId: "tenant-a", position: { lat: 37.77, lng: -122.41 }, status: "available" },
      ]);

      await handler(event, {} as any, () => {});

      // Verify only tenant-a connections received the update
      const postCalls = apiGwMock.commandCalls(PostToConnectionCommand);
      expect(postCalls.length).toBe(2); // conn-1 and conn-2
      
      const connectionIds = postCalls.map(call => call.args[0].input.ConnectionId);
      expect(connectionIds).toContain("conn-1");
      expect(connectionIds).toContain("conn-2");
      expect(connectionIds).not.toContain("conn-3");
    });

    it("should broadcast to default tenant connections when vehicle has no tenantId", async () => {
      const connections = [
        { connectionId: "conn-1", tenantId: "default" },
        { connectionId: "conn-2", tenantId: "tenant-a" },
      ];
      ddbMock.on(ScanCommand).resolves({ Items: connections });
      apiGwMock.on(PostToConnectionCommand).resolves({});

      // Vehicle update without tenantId (defaults to "default")
      const event = createStreamEvent([
        { vehicleId: "vehicle-001", position: { lat: 37.77, lng: -122.41 }, status: "available" },
      ]);

      await handler(event, {} as any, () => {});

      // Verify only default tenant connection received the update
      const postCalls = apiGwMock.commandCalls(PostToConnectionCommand);
      expect(postCalls.length).toBe(1);
      expect(postCalls[0].args[0].input.ConnectionId).toBe("conn-1");
    });

    it("should handle multiple tenants in single stream batch", async () => {
      const connections = [
        { connectionId: "conn-1", tenantId: "tenant-a" },
        { connectionId: "conn-2", tenantId: "tenant-b" },
      ];
      ddbMock.on(ScanCommand).resolves({ Items: connections });
      apiGwMock.on(PostToConnectionCommand).resolves({});

      // Vehicle updates for both tenants
      const event = createStreamEvent([
        { vehicleId: "vehicle-001", tenantId: "tenant-a", position: { lat: 37.77, lng: -122.41 }, status: "available" },
        { vehicleId: "vehicle-002", tenantId: "tenant-b", position: { lat: 37.78, lng: -122.42 }, status: "en-route" },
      ]);

      await handler(event, {} as any, () => {});

      // Verify each tenant received only their vehicle update
      const postCalls = apiGwMock.commandCalls(PostToConnectionCommand);
      expect(postCalls.length).toBe(2);

      // Find calls by connection ID
      const conn1Call = postCalls.find(c => c.args[0].input.ConnectionId === "conn-1");
      const conn2Call = postCalls.find(c => c.args[0].input.ConnectionId === "conn-2");

      expect(conn1Call).toBeDefined();
      expect(conn2Call).toBeDefined();

      // Verify message content
      const conn1Message = JSON.parse(conn1Call!.args[0].input.Data!.toString());
      const conn2Message = JSON.parse(conn2Call!.args[0].input.Data!.toString());

      expect(conn1Message.data.vehicleId).toBe("vehicle-001");
      expect(conn2Message.data.vehicleId).toBe("vehicle-002");
    });

    it("should not broadcast when no connections exist for tenant", async () => {
      const connections = [
        { connectionId: "conn-1", tenantId: "tenant-b" },
      ];
      ddbMock.on(ScanCommand).resolves({ Items: connections });
      apiGwMock.on(PostToConnectionCommand).resolves({});

      // Vehicle update for tenant-a (no connections)
      const event = createStreamEvent([
        { vehicleId: "vehicle-001", tenantId: "tenant-a", position: { lat: 37.77, lng: -122.41 }, status: "available" },
      ]);

      await handler(event, {} as any, () => {});

      // Verify no broadcasts were made
      const postCalls = apiGwMock.commandCalls(PostToConnectionCommand);
      expect(postCalls.length).toBe(0);
    });
  });

  describe("Stale Connection Cleanup", () => {
    it("should remove stale connections on GoneException", async () => {
      const connections = [
        { connectionId: "conn-1", tenantId: "tenant-a" },
        { connectionId: "conn-stale", tenantId: "tenant-a" },
      ];
      ddbMock.on(ScanCommand).resolves({ Items: connections });
      ddbMock.on(DeleteCommand).resolves({});
      
      // First connection succeeds, second throws GoneException
      apiGwMock.on(PostToConnectionCommand)
        .callsFakeOnce(() => Promise.resolve({}))
        .callsFakeOnce(() => Promise.reject(new GoneException({ message: "Gone", $metadata: {} })));

      const event = createStreamEvent([
        { vehicleId: "vehicle-001", tenantId: "tenant-a", position: { lat: 37.77, lng: -122.41 }, status: "available" },
      ]);

      await handler(event, {} as any, () => {});

      // Verify stale connection was deleted
      const deleteCalls = ddbMock.commandCalls(DeleteCommand);
      expect(deleteCalls.length).toBe(1);
      expect(deleteCalls[0].args[0].input.Key).toEqual({ connectionId: "conn-stale" });
    });
  });

  describe("No Updates Handling", () => {
    it("should handle empty stream events gracefully", async () => {
      const event: DynamoDBStreamEvent = { Records: [] };

      await handler(event, {} as any, () => {});

      // Verify no DynamoDB scan was performed
      const scanCalls = ddbMock.commandCalls(ScanCommand);
      expect(scanCalls.length).toBe(0);
    });

    it("should skip DELETE events", async () => {
      const event: DynamoDBStreamEvent = {
        Records: [{
          eventID: "event-1",
          eventName: "REMOVE",
          eventVersion: "1.1",
          eventSource: "aws:dynamodb",
          awsRegion: "us-east-1",
          dynamodb: {
            Keys: { vehicleId: { S: "vehicle-001" } },
            StreamViewType: "NEW_IMAGE",
            SequenceNumber: "1",
            SizeBytes: 100,
          },
          eventSourceARN: "arn:aws:dynamodb:us-east-1:123456789012:table/vehicle-current-state/stream/2024-01-01T00:00:00.000",
        }],
      };

      await handler(event, {} as any, () => {});

      // Verify no DynamoDB scan was performed (no updates to broadcast)
      const scanCalls = ddbMock.commandCalls(ScanCommand);
      expect(scanCalls.length).toBe(0);
    });
  });

  describe("No Connections Handling", () => {
    it("should handle no active connections gracefully", async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] });

      const event = createStreamEvent([
        { vehicleId: "vehicle-001", tenantId: "tenant-a", position: { lat: 37.77, lng: -122.41 }, status: "available" },
      ]);

      await handler(event, {} as any, () => {});

      // Verify no broadcasts were attempted
      const postCalls = apiGwMock.commandCalls(PostToConnectionCommand);
      expect(postCalls.length).toBe(0);
    });
  });
});
