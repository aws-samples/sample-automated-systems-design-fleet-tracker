/**
 * Tenant Management API Lambda Handler
 * 
 * Task 15: Tenant Management API
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6
 * 
 * Endpoints:
 * - POST /admin/tenants - Create new tenant
 * - GET /admin/tenants - List all tenants
 * - GET /admin/tenants/{tenantId} - Get tenant details
 * - PUT /admin/tenants/{tenantId} - Update tenant (enable/disable)
 */

import { APIGatewayProxyHandler, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);

const TENANTS_TABLE = process.env.TENANTS_TABLE!;

// Tenant record structure
interface Tenant {
  tenantId: string;
  name: string;
  contactEmail: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// Helper to create API response
function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
    },
    body: JSON.stringify(body),
  };
}

// Task 15.8: Check if user has platform_admin role
function isPlatformAdmin(event: Parameters<APIGatewayProxyHandler>[0]): boolean {
  const claims = event.requestContext?.authorizer?.claims;
  if (!claims) return false;
  
  // Check for platform_admin in cognito:groups claim
  const groups = claims["cognito:groups"];
  if (typeof groups === "string") {
    return groups.split(",").includes("platform_admin");
  }
  if (Array.isArray(groups)) {
    return groups.includes("platform_admin");
  }
  
  // Also check custom:role claim
  const role = claims["custom:role"];
  return role === "platform_admin";
}

export const handler: APIGatewayProxyHandler = async (event): Promise<APIGatewayProxyResult> => {
  console.log("Request:", JSON.stringify({
    httpMethod: event.httpMethod,
    path: event.path,
    pathParameters: event.pathParameters,
    queryStringParameters: event.queryStringParameters,
  }));

  try {
    const { httpMethod, path, pathParameters } = event;

    // Task 15.8: Require platform_admin role for all /admin/* endpoints
    if (!isPlatformAdmin(event)) {
      return response(403, { error: "Forbidden", message: "Platform admin role required" });
    }

    // Route handling
    if (path === "/admin/tenants" || path === "/admin/tenants/") {
      if (httpMethod === "POST") {
        return await createTenant(event);
      }
      if (httpMethod === "GET") {
        return await listTenants();
      }
    }

    if (path.startsWith("/admin/tenants/") && pathParameters?.tenantId) {
      const tenantId = pathParameters.tenantId;
      if (httpMethod === "GET") {
        return await getTenant(tenantId);
      }
      if (httpMethod === "PUT") {
        return await updateTenant(tenantId, event);
      }
    }

    return response(404, { error: "Not Found", message: "Route not found" });
  } catch (error) {
    console.error("Error:", error);
    return response(500, { error: "Internal Server Error", message: "An unexpected error occurred" });
  }
};

/**
 * Task 15.2: Create new tenant
 * Requirements: 14.1, 14.2
 */
async function createTenant(event: Parameters<APIGatewayProxyHandler>[0]): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return response(400, { error: "Bad Request", message: "Request body is required" });
  }

  let body: { name?: string; contactEmail?: string };
  try {
    body = JSON.parse(event.body);
  } catch {
    return response(400, { error: "Bad Request", message: "Invalid JSON body" });
  }

  const { name, contactEmail } = body;

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return response(400, { error: "Bad Request", message: "name is required" });
  }

  if (!contactEmail || typeof contactEmail !== "string") {
    return response(400, { error: "Bad Request", message: "contactEmail is required" });
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(contactEmail)) {
    return response(400, { error: "Bad Request", message: "Invalid email format" });
  }

  // Task 15.2: Generate UUID for tenantId
  const tenantId = randomUUID();
  const now = new Date().toISOString();

  const tenant: Tenant = {
    tenantId,
    name: name.trim(),
    contactEmail,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: TENANTS_TABLE,
      Item: tenant,
      ConditionExpression: "attribute_not_exists(tenantId)",
    })
  );

  console.log("Tenant created:", { tenantId, name: tenant.name });

  return response(201, { tenant });
}

/**
 * Task 15.4: List all tenants
 * Requirements: 14.3
 */
async function listTenants(): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new ScanCommand({
      TableName: TENANTS_TABLE,
    })
  );

  const tenants = (result.Items || []) as Tenant[];

  return response(200, { tenants, count: tenants.length });
}

/**
 * Get tenant by ID
 */
async function getTenant(tenantId: string): Promise<APIGatewayProxyResult> {
  const result = await docClient.send(
    new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { tenantId },
    })
  );

  if (!result.Item) {
    return response(404, { error: "Not Found", message: "Tenant not found" });
  }

  return response(200, { tenant: result.Item as Tenant });
}

/**
 * Task 15.5: Update tenant (enable/disable)
 * Requirements: 14.4
 */
async function updateTenant(
  tenantId: string,
  event: Parameters<APIGatewayProxyHandler>[0]
): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return response(400, { error: "Bad Request", message: "Request body is required" });
  }

  let body: { enabled?: boolean; name?: string; contactEmail?: string };
  try {
    body = JSON.parse(event.body);
  } catch {
    return response(400, { error: "Bad Request", message: "Invalid JSON body" });
  }

  // Check tenant exists
  const existing = await docClient.send(
    new GetCommand({
      TableName: TENANTS_TABLE,
      Key: { tenantId },
    })
  );

  if (!existing.Item) {
    return response(404, { error: "Not Found", message: "Tenant not found" });
  }

  // Build update expression
  const updateExpressions: string[] = ["updatedAt = :updatedAt"];
  const expressionAttributeValues: Record<string, unknown> = {
    ":updatedAt": new Date().toISOString(),
  };

  if (typeof body.enabled === "boolean") {
    updateExpressions.push("enabled = :enabled");
    expressionAttributeValues[":enabled"] = body.enabled;
  }

  if (body.name && typeof body.name === "string") {
    updateExpressions.push("#name = :name");
    expressionAttributeValues[":name"] = body.name.trim();
  }

  if (body.contactEmail && typeof body.contactEmail === "string") {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(body.contactEmail)) {
      return response(400, { error: "Bad Request", message: "Invalid email format" });
    }
    updateExpressions.push("contactEmail = :contactEmail");
    expressionAttributeValues[":contactEmail"] = body.contactEmail;
  }

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TENANTS_TABLE,
      Key: { tenantId },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ExpressionAttributeNames: body.name ? { "#name": "name" } : undefined,
      ReturnValues: "ALL_NEW",
    })
  );

  console.log("Tenant updated:", { tenantId, enabled: body.enabled });

  return response(200, { tenant: result.Attributes as Tenant });
}
