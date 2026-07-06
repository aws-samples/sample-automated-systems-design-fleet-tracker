/**
 * WebSocket Connect Lambda Handler
 * Validates Cognito JWT token and stores connection in DynamoDB
 *
 * Requirements: 5.2, 5.13, 8.10
 * - WebSocket API validates Cognito token on $connect
 * - Connection management Lambda handles $connect route
 * 
 * Task 14.4: Extract tenantId from JWT token and store with connection
 * Requirements: 13.4 - Extract tenantId from JWT token on connection
 */

import { APIGatewayProxyHandler, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { CognitoJwtVerifier } from "aws-jwt-verify";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const CLIENT_ID = process.env.CLIENT_ID!;

// Create JWT verifier for Cognito tokens
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | null = null;

function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: USER_POOL_ID,
      tokenUse: "id",
      clientId: CLIENT_ID,
    });
  }
  return verifier;
}

export const handler: APIGatewayProxyHandler = async (event): Promise<APIGatewayProxyResult> => {
  console.log("WebSocket connect event:", JSON.stringify(event, null, 2));

  const connectionId = event.requestContext.connectionId;
  if (!connectionId) {
    console.error("No connectionId in request context");
    return { statusCode: 400, body: "Missing connectionId" };
  }

  // Extract token from query string
  const token = event.queryStringParameters?.token;
  if (!token) {
    console.error("No token provided in query string");
    return { statusCode: 401, body: "Unauthorized: No token provided" };
  }

  try {
    // Validate Cognito JWT token
    const jwtVerifier = getVerifier();
    const payload = await jwtVerifier.verify(token);
    
    console.log("Token verified for user:", payload.sub);

    // Task 14.4: Extract tenantId from custom claim
    // The custom attribute is stored as "custom:tenantId" in the JWT
    const tenantId = (payload as Record<string, unknown>)["custom:tenantId"] as string | undefined;
    
    if (!tenantId) {
      console.warn("No tenantId in token claims, using default tenant");
    }

    // Calculate TTL (24 hours from now)
    const ttl = Math.floor(Date.now() / 1000) + 24 * 60 * 60;

    // Store connection in DynamoDB with tenantId
    await docClient.send(
      new PutCommand({
        TableName: CONNECTIONS_TABLE,
        Item: {
          connectionId,
          userId: payload.sub,
          email: payload.email || "unknown",
          tenantId: tenantId || "default", // Store tenantId for filtering broadcasts
          connectedAt: new Date().toISOString(),
          ttl,
        },
      })
    );

    console.log(`Connection ${connectionId} stored for user ${payload.sub}, tenant ${tenantId || "default"}`);

    return { statusCode: 200, body: "Connected" };
  } catch (error) {
    console.error("Connection error:", error);
    
    if (error instanceof Error && error.name === "JwtExpiredError") {
      return { statusCode: 401, body: "Unauthorized: Token expired" };
    }
    
    if (error instanceof Error && error.name === "JwtInvalidClaimError") {
      return { statusCode: 401, body: "Unauthorized: Invalid token claims" };
    }

    return { statusCode: 401, body: "Unauthorized: Invalid token" };
  }
};
