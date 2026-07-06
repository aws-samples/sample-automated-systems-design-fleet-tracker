/**
 * Unit Tests for Tenant Management API
 * Task 15.10: Unit tests for tenant management API
 */

import { APIGatewayProxyEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";

// Set environment variables BEFORE importing handler
process.env.TENANTS_TABLE = "tenants";

import { handler } from "./index";

const ddbMock = mockClient(DynamoDBDocumentClient);

function createEvent(
  httpMethod: string,
  path: string,
  options: {
    pathParameters?: Record<string, string>;
    body?: object;
    isAdmin?: boolean;
  } = {}
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
      authorizer: {
        claims: options.isAdmin !== false ? { "custom:role": "platform_admin" } : {},
      },
    } as any,
    resource: "",
  };
}

describe("Tenant Management API", () => {
  beforeEach(() => {
    ddbMock.reset();
    jest.clearAllMocks();
  });

  describe("Authorization (Task 15.8)", () => {
    it("should return 403 for non-admin users", async () => {
      const event = createEvent("GET", "/admin/tenants", { isAdmin: false });
      const result = await handler(event, {} as any, () => {});
      
      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(403);
      expect(JSON.parse(result!.body).error).toBe("Forbidden");
    });

    it("should allow platform_admin users", async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] });
      
      const event = createEvent("GET", "/admin/tenants", { isAdmin: true });
      const result = await handler(event, {} as any, () => {});
      
      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(200);
    });
  });

  describe("POST /admin/tenants (Task 15.2)", () => {
    it("should create tenant with UUID", async () => {
      ddbMock.on(PutCommand).resolves({});

      const event = createEvent("POST", "/admin/tenants", {
        body: { name: "Acme Corp", contactEmail: "admin@acme.com" },
      });
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(201);
      const body = JSON.parse(result!.body);
      expect(body.tenant.tenantId).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.tenant.name).toBe("Acme Corp");
      expect(body.tenant.enabled).toBe(true);
    });

    it("should return 400 when name is missing", async () => {
      const event = createEvent("POST", "/admin/tenants", {
        body: { contactEmail: "admin@acme.com" },
      });
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(400);
      expect(JSON.parse(result!.body).message).toContain("name");
    });

    it("should return 400 for invalid email", async () => {
      const event = createEvent("POST", "/admin/tenants", {
        body: { name: "Acme Corp", contactEmail: "invalid" },
      });
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(400);
      expect(JSON.parse(result!.body).message).toContain("email");
    });
  });

  describe("GET /admin/tenants (Task 15.4)", () => {
    it("should list all tenants", async () => {
      const tenants = [
        { tenantId: "t1", name: "Tenant 1", enabled: true },
        { tenantId: "t2", name: "Tenant 2", enabled: false },
      ];
      ddbMock.on(ScanCommand).resolves({ Items: tenants });

      const event = createEvent("GET", "/admin/tenants");
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(200);
      const body = JSON.parse(result!.body);
      expect(body.tenants).toHaveLength(2);
      expect(body.count).toBe(2);
    });
  });

  describe("PUT /admin/tenants/{tenantId} (Task 15.5)", () => {
    it("should disable tenant", async () => {
      ddbMock.on(GetCommand).resolves({ Item: { tenantId: "t1", enabled: true } });
      ddbMock.on(UpdateCommand).resolves({
        Attributes: { tenantId: "t1", enabled: false },
      });

      const event = createEvent("PUT", "/admin/tenants/t1", {
        pathParameters: { tenantId: "t1" },
        body: { enabled: false },
      });
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(200);
      const body = JSON.parse(result!.body);
      expect(body.tenant.enabled).toBe(false);
    });

    it("should return 404 for non-existent tenant", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = createEvent("PUT", "/admin/tenants/unknown", {
        pathParameters: { tenantId: "unknown" },
        body: { enabled: false },
      });
      const result = await handler(event, {} as any, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(404);
    });
  });
});
