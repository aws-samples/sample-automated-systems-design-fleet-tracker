/**
 * Unit Tests for ServiceNow Handler
 * Tasks 25.3, 27.8: Unit tests for ServiceNow integration
 */

import { SNSEvent, ScheduledEvent, APIGatewayProxyEvent, Context } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

// Set environment variables BEFORE importing handler
process.env.INCIDENTS_TABLE = "servicenow-incidents";
process.env.DISPATCH_TABLE = "dispatch-assignments";
process.env.VEHICLE_STATE_TABLE = "vehicle-current-state";
process.env.SERVICENOW_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:123456789012:secret:servicenow";

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

import { alarmHandler, overdueJobHandler, staleVehicleHandler, manualIncidentHandler } from "./index";

const ddbMock = mockClient(DynamoDBDocumentClient);
const secretsMock = mockClient(SecretsManagerClient);

const mockContext: Context = {
  awsRequestId: "test-request-id",
  callbackWaitsForEmptyEventLoop: false,
  functionName: "servicenow-handler",
  functionVersion: "1",
  invokedFunctionArn: "arn:aws:lambda:us-west-2:123456789012:function:servicenow-handler",
  memoryLimitInMB: "256",
  logGroupName: "/aws/lambda/servicenow-handler",
  logStreamName: "2024/03/15/[$LATEST]abc123",
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

const mockCredentials = {
  instanceUrl: "https://test.service-now.com",
  username: "admin",
  password: "password123",
};

describe("ServiceNow Handler", () => {
  beforeEach(() => {
    ddbMock.reset();
    secretsMock.reset();
    mockFetch.mockReset();

    // Default mock for credentials
    secretsMock.on(GetSecretValueCommand).resolves({
      SecretString: JSON.stringify(mockCredentials),
    });

    // Default mock for ServiceNow API
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: { sys_id: "INC0001234" } }),
    });
  });

  describe("Alarm Handler (Task 25)", () => {
    const createSNSEvent = (alarmName: string, state: string): SNSEvent => ({
      Records: [
        {
          EventSource: "aws:sns",
          EventVersion: "1.0",
          EventSubscriptionArn: "arn:aws:sns:us-west-2:123456789012:test",
          Sns: {
            Type: "Notification",
            MessageId: "test-message-id",
            TopicArn: "arn:aws:sns:us-west-2:123456789012:test",
            Subject: "ALARM",
            Message: JSON.stringify({
              AlarmName: alarmName,
              AlarmDescription: "Test alarm",
              NewStateValue: state,
              StateChangeTime: "2024-01-01T12:00:00Z",
            }),
            Timestamp: "2024-01-01T12:00:00Z",
            SignatureVersion: "1",
            Signature: "test",
            SigningCertUrl: "https://test.com",
            UnsubscribeUrl: "https://test.com",
            MessageAttributes: {},
          },
        },
      ],
    });

    it("should create incident for ALARM state", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});

      const event = createSNSEvent("HighErrorRate", "ALARM");
      await alarmHandler(event, mockContext, () => {});

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/now/table/incident"),
        expect.objectContaining({ method: "POST" })
      );

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Item?.incidentKey).toBe("alarm-HighErrorRate");
    });

    it("should skip non-ALARM states", async () => {
      const event = createSNSEvent("HighErrorRate", "OK");
      await alarmHandler(event, mockContext, () => {});

      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("should skip if incident already exists", async () => {
      ddbMock.on(GetCommand).resolves({
        Item: { incidentKey: "alarm-HighErrorRate", status: "open" },
      });

      const event = createSNSEvent("HighErrorRate", "ALARM");
      await alarmHandler(event, mockContext, () => {});

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("Overdue Job Handler (Task 26)", () => {
    const mockScheduledEvent: ScheduledEvent = {
      version: "0",
      id: "test-event-id",
      "detail-type": "Scheduled Event",
      source: "aws.events",
      account: "123456789012",
      time: "2024-01-01T12:00:00Z",
      region: "us-west-2",
      resources: [],
      detail: {},
    };

    it("should create incident for overdue jobs", async () => {
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      
      ddbMock.on(ScanCommand).resolvesOnce({
        Items: [
          {
            jobId: "job-123",
            vehicleId: "vehicle-001",
            status: "en-route",
            createdAt: threeHoursAgo,
            address: "123 Main St",
          },
        ],
      });
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});

      await overdueJobHandler(mockScheduledEvent, mockContext, () => {});

      expect(mockFetch).toHaveBeenCalled();
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Item?.incidentKey).toBe("overdue-job-job-123");
    });

    it("should set high urgency for jobs over 4 hours", async () => {
      const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
      
      ddbMock.on(ScanCommand).resolvesOnce({
        Items: [
          {
            jobId: "job-456",
            vehicleId: "vehicle-002",
            status: "en-route",
            createdAt: fiveHoursAgo,
            address: "456 Oak Ave",
          },
        ],
      });
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});

      await overdueJobHandler(mockScheduledEvent, mockContext, () => {});

      const fetchCall = mockFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.urgency).toBe("1"); // High urgency
    });
  });

  describe("Stale Vehicle Handler (Task 27)", () => {
    const mockScheduledEvent: ScheduledEvent = {
      version: "0",
      id: "test-event-id",
      "detail-type": "Scheduled Event",
      source: "aws.events",
      account: "123456789012",
      time: "2024-01-01T12:00:00Z",
      region: "us-west-2",
      resources: [],
      detail: {},
    };

    it("should create incident for stale vehicles", async () => {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      
      ddbMock.on(ScanCommand).resolvesOnce({
        Items: [
          {
            vehicleId: "vehicle-001",
            status: "en-route",
            lastSeen: fifteenMinutesAgo,
            position: { lat: 47.6062, lng: -122.3321 },
            assignedJobId: "job-123",
          },
        ],
      });
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(QueryCommand).resolves({
        Items: [{ jobId: "job-123", address: "123 Main St" }],
      });
      ddbMock.on(PutCommand).resolves({});

      await staleVehicleHandler(mockScheduledEvent, mockContext, () => {});

      expect(mockFetch).toHaveBeenCalled();
      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0].args[0].input.Item?.incidentKey).toBe("stale-vehicle-vehicle-001");
    });

    it("should skip if incident already exists", async () => {
      const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      
      ddbMock.on(ScanCommand).resolvesOnce({
        Items: [
          {
            vehicleId: "vehicle-001",
            status: "en-route",
            lastSeen: fifteenMinutesAgo,
          },
        ],
      });
      ddbMock.on(GetCommand).resolves({
        Item: { incidentKey: "stale-vehicle-vehicle-001", status: "open" },
      });

      await staleVehicleHandler(mockScheduledEvent, mockContext, () => {});

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("Manual Incident Handler (Task 27.6)", () => {
    const createAPIEvent = (body: object): APIGatewayProxyEvent => ({
      httpMethod: "POST",
      path: "/incidents",
      pathParameters: null,
      queryStringParameters: null,
      multiValueQueryStringParameters: null,
      body: JSON.stringify(body),
      headers: {},
      multiValueHeaders: {},
      isBase64Encoded: false,
      stageVariables: null,
      requestContext: {} as any,
      resource: "",
    });

    it("should create manual incident", async () => {
      ddbMock.on(PutCommand).resolves({});

      const event = createAPIEvent({
        vehicleId: "vehicle-001",
        description: "Driver reported mechanical issue",
        urgency: "1",
      });

      const result = await manualIncidentHandler(event, mockContext, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(201);
      expect(mockFetch).toHaveBeenCalled();
    });

    it("should return 400 for missing required fields", async () => {
      const event = createAPIEvent({ vehicleId: "vehicle-001" });
      const result = await manualIncidentHandler(event, mockContext, () => {});

      expect(result).toBeDefined();
      expect(result!.statusCode).toBe(400);
    });
  });

  describe("Retry logic (Task 24.3)", () => {
    it("should retry on ServiceNow API failure", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      ddbMock.on(PutCommand).resolves({});

      mockFetch
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ result: { sys_id: "INC0001234" } }),
        });

      const event: SNSEvent = {
        Records: [
          {
            EventSource: "aws:sns",
            EventVersion: "1.0",
            EventSubscriptionArn: "arn:aws:sns:us-west-2:123456789012:test",
            Sns: {
              Type: "Notification",
              MessageId: "test-message-id",
              TopicArn: "arn:aws:sns:us-west-2:123456789012:test",
              Subject: "ALARM",
              Message: JSON.stringify({
                AlarmName: "TestAlarm",
                NewStateValue: "ALARM",
                StateChangeTime: "2024-01-01T12:00:00Z",
              }),
              Timestamp: "2024-01-01T12:00:00Z",
              SignatureVersion: "1",
              Signature: "test",
              SigningCertUrl: "https://test.com",
              UnsubscribeUrl: "https://test.com",
              MessageAttributes: {},
            },
          },
        ],
      };

      await alarmHandler(event, mockContext, () => {});

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
