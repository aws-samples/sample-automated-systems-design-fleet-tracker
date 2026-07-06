/**
 * WebSocket Disconnect Lambda Handler
 * Removes connection from DynamoDB when client disconnects
 *
 * Requirements: 5.13
 * - Connection management Lambda handles $disconnect route
 */

import { APIGatewayProxyHandler, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;

export const handler: APIGatewayProxyHandler = async (event): Promise<APIGatewayProxyResult> => {
  console.log("WebSocket disconnect event:", JSON.stringify(event, null, 2));

  const connectionId = event.requestContext.connectionId;
  if (!connectionId) {
    console.error("No connectionId in request context");
    return { statusCode: 400, body: "Missing connectionId" };
  }

  try {
    // Remove connection from DynamoDB
    await docClient.send(
      new DeleteCommand({
        TableName: CONNECTIONS_TABLE,
        Key: { connectionId },
      })
    );

    console.log(`Connection ${connectionId} removed`);

    return { statusCode: 200, body: "Disconnected" };
  } catch (error) {
    console.error("Disconnect error:", error);
    // Still return success - connection cleanup is best effort
    return { statusCode: 200, body: "Disconnected" };
  }
};
