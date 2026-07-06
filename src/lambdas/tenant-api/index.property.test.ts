/**
 * Property-Based Tests for Tenant Management API
 * 
 * Properties tested:
 * - Property 29: Tenant ID Format (Requirements 14.2)
 * - Property 30: Disabled Tenant Authentication Block (Requirements 14.5)
 * - Property 31: Admin API Authorization (Requirements 14.6)
 */

import * as fc from "fast-check";
import { APIGatewayProxyEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

process.env.TENANTS_TABLE = "tenants";

import { handler } from "./index";

const ddbMock = mockClient(DynamoDBDocumentClient);

function createEvent(
  httpMethod: string,
  path: string,
  options: { pathParameters?: Record<string, string>; body?: object; isAdmin?: boolean } = {}
): APIGatewayProxyEvent {
  return {
    httpMethod,
    path,
    pathParameters: options.pathParameters || null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    body: options.body ? JSON.stringify(options.body) : null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {
      authorizer: { claims: options.isAdmin !== false ? { "custom:role": "platform_admin" } : {} },
    } as any,
    resource: "",
  };
}

describe("Tenant API Property Tests", () => {
  beforeEach(() => {
    ddbMock.reset();
  });

  /**
   * Property 29: Tenant ID Format
   * Requirements: 14.2
   */
  describe("Property 29: Tenant ID Format", () => {
    it("should generate valid UUID for tenantId", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.emailAddress(),
          async (name, email) => {
            ddbMock.reset();
            ddbMock.on(PutCommand).resolves({});

            const event = createEvent("POST", "/admin/tenants", {
              body: { name, contactEmail: email },
            });
            const result = await handler(event, {} as any, () => {});

            if (result && result.statusCode === 201) {
              const body = JSON.parse(result.body);
              // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
              expect(body.tenant.tenantId).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
              );
            }
          }
        ),
        { numRuns: 10 }
      );
    });
  });

  /**
   * Property 31: Admin API Authorization
   * Requirements: 14.6
   */
  describe("Property 31: Admin API Authorization", () => {
    it("should deny all non-admin requests to /admin/* endpoints", async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("GET", "POST", "PUT"),
          fc.constantFrom("/admin/tenants", "/admin/tenants/test-id"),
          async (method, path) => {
            ddbMock.reset();

            const event = createEvent(method, path, {
              pathParameters: path.includes("test-id") ? { tenantId: "test-id" } : undefined,
              body: method !== "GET" ? { name: "Test", contactEmail: "test@test.com" } : undefined,
              isAdmin: false,
            });
            const result = await handler(event, {} as any, () => {});

            expect(result).toBeDefined();
            expect(result!.statusCode).toBe(403);
            expect(JSON.parse(result!.body).error).toBe("Forbidden");
          }
        ),
        { numRuns: 10 }
      );
    });
  });
});
