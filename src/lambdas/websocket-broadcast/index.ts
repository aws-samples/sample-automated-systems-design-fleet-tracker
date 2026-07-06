/**
 * WebSocket Broadcast Lambda Handler
 * Triggered by DynamoDB Streams on vehicle-current-state table
 * Broadcasts vehicle position updates to connected WebSocket clients
 *
 * Requirements: 5.2, 5.12
 * - API Gateway WebSocket API pushes real-time position updates to connected clients
 * - Dashboard refreshes vehicle positions within 5 seconds of WebSocket message receipt
 * 
 * Task 14.5: Tenant-filtered WebSocket broadcasts
 * Requirements: 13.5 - Only send updates to connections with matching tenantId
 */

import { DynamoDBStreamHandler } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ApiGatewayManagementApiClient, PostToConnectionCommand, GoneException } from "@aws-sdk/client-apigatewaymanagementapi";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { AttributeValue } from "@aws-sdk/client-dynamodb";
import { WebSocketMessage, VehicleUpdateMessage, VehicleState } from "../../shared/types";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT!;

// Connection record with tenantId
interface ConnectionRecord {
  connectionId: string;
  tenantId?: string;
}

// Create API Gateway Management API client
let apiGwClient: ApiGatewayManagementApiClient | null = null;

function getApiGwClient(): ApiGatewayManagementApiClient {
  if (!apiGwClient) {
    apiGwClient = new ApiGatewayManagementApiClient({
      endpoint: WEBSOCKET_ENDPOINT,
    });
  }
  return apiGwClient;
}

export const handler: DynamoDBStreamHandler = async (event) => {
  console.log("DynamoDB Stream event:", JSON.stringify(event, null, 2));

  // Collect all vehicle updates from the stream, grouped by tenantId
  const vehicleUpdatesByTenant: Map<string, VehicleUpdateMessage[]> = new Map();

  for (const record of event.Records) {
    // Only process INSERT and MODIFY events (new or updated records)
    if (record.eventName !== "INSERT" && record.eventName !== "MODIFY") {
      continue;
    }

    if (!record.dynamodb?.NewImage) {
      continue;
    }

    try {
      // Unmarshall the DynamoDB record
      const vehicleState = unmarshall(
        record.dynamodb.NewImage as Record<string, AttributeValue>
      ) as VehicleState;

      // Create vehicle update message
      const update: VehicleUpdateMessage = {
        vehicleId: vehicleState.vehicleId,
        position: vehicleState.position,
        heading: vehicleState.heading,
        speed: vehicleState.speed,
        status: vehicleState.status,
        ignition: vehicleState.ignition,
        assignedJobId: vehicleState.assignedJobId,
      };

      // Group updates by tenantId for tenant-filtered broadcasts
      const tenantId = vehicleState.tenantId || "default";
      if (!vehicleUpdatesByTenant.has(tenantId)) {
        vehicleUpdatesByTenant.set(tenantId, []);
      }
      vehicleUpdatesByTenant.get(tenantId)!.push(update);
    } catch (error) {
      console.error("Error processing stream record:", error);
    }
  }

  if (vehicleUpdatesByTenant.size === 0) {
    console.log("No vehicle updates to broadcast");
    return;
  }

  // Get all active connections with their tenantIds
  let connections: ConnectionRecord[] = [];
  try {
    const result = await docClient.send(
      new ScanCommand({
        TableName: CONNECTIONS_TABLE,
        ProjectionExpression: "connectionId, tenantId",
      })
    );
    connections = (result.Items || []) as ConnectionRecord[];
  } catch (error) {
    console.error("Error scanning connections:", error);
    return;
  }

  if (connections.length === 0) {
    console.log("No active connections to broadcast to");
    return;
  }

  const totalUpdates = Array.from(vehicleUpdatesByTenant.values()).reduce((sum, arr) => sum + arr.length, 0);
  console.log(`Broadcasting ${totalUpdates} updates across ${vehicleUpdatesByTenant.size} tenants to ${connections.length} connections`);

  const client = getApiGwClient();
  const staleConnections: string[] = [];

  // Task 14.5: Broadcast updates only to connections with matching tenantId
  for (const [tenantId, updates] of vehicleUpdatesByTenant) {
    // Filter connections to only those belonging to this tenant
    const tenantConnections = connections.filter(conn => 
      conn.tenantId === tenantId || conn.tenantId === "default" || !conn.tenantId
    );

    if (tenantConnections.length === 0) {
      console.log(`No connections for tenant ${tenantId}, skipping ${updates.length} updates`);
      continue;
    }

    console.log(`Broadcasting ${updates.length} updates to ${tenantConnections.length} connections for tenant ${tenantId}`);

    // Broadcast each vehicle update to tenant's connections
    for (const update of updates) {
      const message: WebSocketMessage<VehicleUpdateMessage> = {
        type: "VEHICLE_UPDATE",
        data: update,
        timestamp: new Date().toISOString(),
      };

      const messageData = JSON.stringify(message);

      // Send to all tenant connections in parallel
      const sendPromises = tenantConnections.map(async ({ connectionId }) => {
        try {
          await client.send(
            new PostToConnectionCommand({
              ConnectionId: connectionId,
              Data: Buffer.from(messageData),
            })
          );
        } catch (error) {
          // Handle stale connections (410 Gone)
          if (error instanceof GoneException) {
            console.log(`Connection ${connectionId} is stale, marking for removal`);
            if (!staleConnections.includes(connectionId)) {
              staleConnections.push(connectionId);
            }
          } else {
            console.error(`Error sending to connection ${connectionId}:`, error);
          }
        }
      });

      await Promise.all(sendPromises);
    }
  }

  // Clean up stale connections
  if (staleConnections.length > 0) {
    console.log(`Removing ${staleConnections.length} stale connections`);
    
    const deletePromises = staleConnections.map(async (connectionId) => {
      try {
        await docClient.send(
          new DeleteCommand({
            TableName: CONNECTIONS_TABLE,
            Key: { connectionId },
          })
        );
      } catch (error) {
        console.error(`Error deleting stale connection ${connectionId}:`, error);
      }
    });

    await Promise.all(deletePromises);
  }

  console.log("Broadcast complete");
};
