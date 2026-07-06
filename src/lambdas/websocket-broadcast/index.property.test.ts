/**
 * Property-Based Tests for WebSocket Tenant Filtering
 * 
 * Task 14.6: Property test for WebSocket tenant filtering
 * Requirements: 13.4, 13.5
 * 
 * Property 28: WebSocket Tenant Filtering
 * For any vehicle update, only WebSocket connections belonging to the same tenant
 * should receive the broadcast message.
 */

import * as fc from "fast-check";
import { DynamoDBStreamEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

// Set environment variables BEFORE importing handler
process.env.CONNECTIONS_TABLE = "websocket-connections";
process.env.WEBSOCKET_ENDPOINT = "https://test.execute-api.us-east-1.amazonaws.com/v1";

// Import handler AFTER setting environment variables
import { handler } from "./index";

// Mock AWS clients
const ddbMock = mockClient(DynamoDBDocumentClient);
const apiGwMock = mockClient(ApiGatewayManagementApiClient);

// Arbitrary generators
const tenantIdArb = fc.stringMatching(/^tenant-[a-z0-9]{8}$/);
const vehicleIdArb = fc.stringMatching(/^vehicle-[0-9]{3}$/);
const connectionIdArb = fc.stringMatching(/^conn-[a-z0-9]{8}$/);
const latArb = fc.double({ min: -90, max: 90, noNaN: true });
const lngArb = fc.double({ min: -180, max: 180, noNaN: true });

// Helper to create DynamoDB Stream event
function createStreamEvent(records: Array<{
  vehicleId: string;
  tenantId: string;
  position: { lat: number; lng: number };
}>): DynamoDBStreamEvent {
  return {
    Records: records.map((record, index) => ({
      eventID: `event-${index}`,
      eventName: "MODIFY" as const,
      eventVersion: "1.1",
      eventSource: "aws:dynamodb",
      awsRegion: "us-east-1",
      dynamodb: {
        Keys: {
          vehicleId: { S: record.vehicleId },
        },
        NewImage: {
          vehicleId: { S: record.vehicleId },
          tenantId: { S: record.tenantId },
          position: { M: { lat: { N: String(record.position.lat) }, lng: { N: String(record.position.lng) } } },
          heading: { N: "180" },
          speed: { N: "35" },
          status: { S: "available" },
          ignition: { BOOL: true },
        },
        StreamViewType: "NEW_IMAGE",
        SequenceNumber: `${index}`,
        SizeBytes: 100,
      },
      eventSourceARN: "arn:aws:dynamodb:us-east-1:123456789012:table/vehicle-current-state/stream/2024-01-01T00:00:00.000",
    })),
  };
}

describe("WebSocket Tenant Filtering Property Tests", () => {
  beforeEach(() => {
    ddbMock.reset();
    apiGwMock.reset();
    jest.clearAllMocks();
  });

  /**
   * Property 28: WebSocket Tenant Filtering
   * Requirements: 13.4, 13.5
   * 
   * For any vehicle update belonging to tenant T, only WebSocket connections
   * with tenantId = T should receive the broadcast message.
   */
  describe("Property 28: WebSocket Tenant Filtering", () => {
    it("should only broadcast to connections with matching tenantId", async () => {
      await fc.assert(
        fc.asyncProperty(
          tenantIdArb,
          tenantIdArb,
          vehicleIdArb,
          connectionIdArb,
          connectionIdArb,
          latArb,
          lngArb,
          async (vehicleTenantId, otherTenantId, vehicleId, matchingConnId, otherConnId, lat, lng) => {
            // Skip if tenants are the same (we need different tenants to test isolation)
            if (vehicleTenantId === otherTenantId) return;
            // Skip if connection IDs are the same
            if (matchingConnId === otherConnId) return;

            ddbMock.reset();
            apiGwMock.reset();

            // Setup connections: one matching tenant, one different tenant
            const connections = [
              { connectionId: matchingConnId, tenantId: vehicleTenantId },
              { connectionId: otherConnId, tenantId: otherTenantId },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: connections });
            apiGwMock.on(PostToConnectionCommand).resolves({});

            // Create vehicle update for vehicleTenantId
            const event = createStreamEvent([
              { vehicleId, tenantId: vehicleTenantId, position: { lat, lng } },
            ]);

            await handler(event, {} as any, () => {});

            // Verify only matching tenant connection received the broadcast
            const postCalls = apiGwMock.commandCalls(PostToConnectionCommand);
            expect(postCalls.length).toBe(1);
            expect(postCalls[0].args[0].input.ConnectionId).toBe(matchingConnId);

            // Verify the message contains correct vehicle data
            const message = JSON.parse(postCalls[0].args[0].input.Data!.toString());
            expect(message.type).toBe("VEHICLE_UPDATE");
            expect(message.data.vehicleId).toBe(vehicleId);
          }
        ),
        { numRuns: 20 }
      );
    });

    it("should broadcast to all connections of the same tenant", async () => {
      await fc.assert(
        fc.asyncProperty(
          tenantIdArb,
          vehicleIdArb,
          fc.array(connectionIdArb, { minLength: 1, maxLength: 5 }),
          latArb,
          lngArb,
          async (tenantId, vehicleId, connectionIds, lat, lng) => {
            // Ensure unique connection IDs
            const uniqueConnIds = [...new Set(connectionIds)];
            if (uniqueConnIds.length === 0) return;

            ddbMock.reset();
            apiGwMock.reset();

            // Setup all connections for the same tenant
            const connections = uniqueConnIds.map(connId => ({
              connectionId: connId,
              tenantId,
            }));
            ddbMock.on(ScanCommand).resolves({ Items: connections });
            apiGwMock.on(PostToConnectionCommand).resolves({});

            // Create vehicle update
            const event = createStreamEvent([
              { vehicleId, tenantId, position: { lat, lng } },
            ]);

            await handler(event, {} as any, () => {});

            // Verify all tenant connections received the broadcast
            const postCalls = apiGwMock.commandCalls(PostToConnectionCommand);
            expect(postCalls.length).toBe(uniqueConnIds.length);

            const receivedConnIds = postCalls.map(c => c.args[0].input.ConnectionId);
            for (const connId of uniqueConnIds) {
              expect(receivedConnIds).toContain(connId);
            }
          }
        ),
        { numRuns: 20 }
      );
    });

    it("should not broadcast when no connections exist for tenant", async () => {
      await fc.assert(
        fc.asyncProperty(
          tenantIdArb,
          tenantIdArb,
          vehicleIdArb,
          connectionIdArb,
          latArb,
          lngArb,
          async (vehicleTenantId, otherTenantId, vehicleId, connId, lat, lng) => {
            // Skip if tenants are the same
            if (vehicleTenantId === otherTenantId) return;

            ddbMock.reset();
            apiGwMock.reset();

            // Setup connection for different tenant only
            const connections = [
              { connectionId: connId, tenantId: otherTenantId },
            ];
            ddbMock.on(ScanCommand).resolves({ Items: connections });
            apiGwMock.on(PostToConnectionCommand).resolves({});

            // Create vehicle update for vehicleTenantId (no matching connections)
            const event = createStreamEvent([
              { vehicleId, tenantId: vehicleTenantId, position: { lat, lng } },
            ]);

            await handler(event, {} as any, () => {});

            // Verify no broadcasts were made
            const postCalls = apiGwMock.commandCalls(PostToConnectionCommand);
            expect(postCalls.length).toBe(0);
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});
