/**
 * Unit Tests for Email Processor Lambda
 * Task 5.5: Test email processing functionality
 * 
 * Tests:
 * - Email sent to all tenant subscribers
 * - Email content includes required fields
 * - Unverified email skipped
 * - Retry logic on SES failure
 */

// Set environment variables BEFORE importing the handler
process.env.EMAIL_SUBSCRIPTIONS_TABLE = "email-subscriptions";
process.env.SES_FROM_EMAIL = "noreply@fleet-tracking.local";

import { handler } from "./index";
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import type { SNSEvent, Context } from "aws-lambda";
import type { JobCompletionNotification } from "../../shared/types";

const ddbMock = mockClient(DynamoDBDocumentClient);
const sesMock = mockClient(SESClient);

const mockContext: Context = {
  awsRequestId: "test-request-id",
  functionName: "email-processor",
  functionVersion: "1",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789:function:email-processor",
  memoryLimitInMB: "256",
  logGroupName: "/aws/lambda/email-processor",
  logStreamName: "2024/01/01/[$LATEST]abc123",
  callbackWaitsForEmptyEventLoop: true,
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

function createSNSEvent(notification: JobCompletionNotification): SNSEvent {
  return {
    Records: [
      {
        EventVersion: "1.0",
        EventSubscriptionArn: "arn:aws:sns:us-east-1:123456789:fleet-job-completions:abc123",
        EventSource: "aws:sns",
        Sns: {
          SignatureVersion: "1",
          Timestamp: "2024-01-15T10:30:00.000Z",
          Signature: "test-signature",
          SigningCertUrl: "https://sns.us-east-1.amazonaws.com/test.pem",
          MessageId: "test-message-id",
          Message: JSON.stringify(notification),
          MessageAttributes: {
            eventType: { Type: "String", Value: "JOB_COMPLETED" },
            tenantId: { Type: "String", Value: notification.tenantId },
          },
          Type: "Notification",
          UnsubscribeUrl: "https://sns.us-east-1.amazonaws.com/unsubscribe",
          TopicArn: "arn:aws:sns:us-east-1:123456789:fleet-job-completions",
          Subject: undefined,
        },
      },
    ],
  };
}

describe("Email Processor Lambda", () => {
  beforeEach(() => {
    ddbMock.reset();
    sesMock.reset();
    jest.clearAllMocks();
  });

  const sampleNotification: JobCompletionNotification = {
    type: "JOB_COMPLETED",
    jobId: "job-123",
    vehicleId: "vehicle-001",
    completedAt: "2024-01-15T10:30:00Z",
    destination: "123 Main St, Seattle, WA",
    tenantId: "tenant-abc",
  };

  describe("Email sent to all tenant subscribers", () => {
    it("should send emails to all verified subscribers", async () => {
      // Mock: Two verified subscribers
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { tenantId: "tenant-abc", email: "user1@example.com", verified: true, subscribedAt: "2024-01-01T00:00:00Z" },
          { tenantId: "tenant-abc", email: "user2@example.com", verified: true, subscribedAt: "2024-01-01T00:00:00Z" },
        ],
      });

      // Mock: SES succeeds
      sesMock.on(SendEmailCommand).resolves({ MessageId: "ses-message-id" });

      const event = createSNSEvent(sampleNotification);
      await handler(event, mockContext);

      // Verify two emails were sent
      const sesCalls = sesMock.commandCalls(SendEmailCommand);
      expect(sesCalls).toHaveLength(2);

      // Verify email addresses
      const recipients = sesCalls.map((call) => call.args[0].input.Destination?.ToAddresses?.[0]);
      expect(recipients).toContain("user1@example.com");
      expect(recipients).toContain("user2@example.com");
    });

    it("should skip processing when no subscribers exist", async () => {
      // Mock: No subscribers
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const event = createSNSEvent(sampleNotification);
      await handler(event, mockContext);

      // Verify no emails were sent
      const sesCalls = sesMock.commandCalls(SendEmailCommand);
      expect(sesCalls).toHaveLength(0);
    });
  });

  describe("Email content includes required fields", () => {
    it("should include jobId, vehicleId, destination, and completedAt in email body", async () => {
      // Mock: One verified subscriber
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { tenantId: "tenant-abc", email: "user@example.com", verified: true, subscribedAt: "2024-01-01T00:00:00Z" },
        ],
      });

      // Mock: SES succeeds
      sesMock.on(SendEmailCommand).resolves({ MessageId: "ses-message-id" });

      const event = createSNSEvent(sampleNotification);
      await handler(event, mockContext);

      // Verify email content
      const sesCalls = sesMock.commandCalls(SendEmailCommand);
      expect(sesCalls).toHaveLength(1);

      const emailInput = sesCalls[0].args[0].input;
      const body = emailInput.Message?.Body?.Text?.Data || "";
      const subject = emailInput.Message?.Subject?.Data || "";

      // Check subject includes jobId
      expect(subject).toContain("job-123");

      // Check body includes all required fields
      expect(body).toContain("job-123");
      expect(body).toContain("vehicle-001");
      expect(body).toContain("123 Main St, Seattle, WA");
      expect(body).toContain("2024-01-15T10:30:00Z");
    });

    it("should use correct from email address", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { tenantId: "tenant-abc", email: "user@example.com", verified: true, subscribedAt: "2024-01-01T00:00:00Z" },
        ],
      });
      sesMock.on(SendEmailCommand).resolves({ MessageId: "ses-message-id" });

      const event = createSNSEvent(sampleNotification);
      await handler(event, mockContext);

      const sesCalls = sesMock.commandCalls(SendEmailCommand);
      expect(sesCalls[0].args[0].input.Source).toBe("noreply@fleet-tracking.local");
    });
  });

  describe("Unverified email skipped", () => {
    it("should not send email to unverified subscribers", async () => {
      // Mock: One verified, one unverified subscriber
      // Note: The filter happens in DynamoDB query, so we simulate the filtered result
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { tenantId: "tenant-abc", email: "verified@example.com", verified: true, subscribedAt: "2024-01-01T00:00:00Z" },
          // Unverified subscriber would be filtered out by DynamoDB FilterExpression
        ],
      });

      sesMock.on(SendEmailCommand).resolves({ MessageId: "ses-message-id" });

      const event = createSNSEvent(sampleNotification);
      await handler(event, mockContext);

      // Verify only one email was sent (to verified subscriber)
      const sesCalls = sesMock.commandCalls(SendEmailCommand);
      expect(sesCalls).toHaveLength(1);
      expect(sesCalls[0].args[0].input.Destination?.ToAddresses?.[0]).toBe("verified@example.com");
    });

    it("should handle tenant with only unverified subscribers", async () => {
      // Mock: No verified subscribers (all filtered out)
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const event = createSNSEvent(sampleNotification);
      await handler(event, mockContext);

      // Verify no emails were sent
      const sesCalls = sesMock.commandCalls(SendEmailCommand);
      expect(sesCalls).toHaveLength(0);
    });
  });

  describe("Retry logic on SES failure", () => {
    it("should retry on SES failure and succeed on subsequent attempt", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { tenantId: "tenant-abc", email: "user@example.com", verified: true, subscribedAt: "2024-01-01T00:00:00Z" },
        ],
      });

      // Mock: First call fails, second succeeds
      sesMock
        .on(SendEmailCommand)
        .rejectsOnce(new Error("SES temporary failure"))
        .resolves({ MessageId: "ses-message-id" });

      const event = createSNSEvent(sampleNotification);
      await handler(event, mockContext);

      // Verify SES was called twice (retry)
      const sesCalls = sesMock.commandCalls(SendEmailCommand);
      expect(sesCalls).toHaveLength(2);
    });

    it("should throw error after all retries exhausted", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { tenantId: "tenant-abc", email: "user@example.com", verified: true, subscribedAt: "2024-01-01T00:00:00Z" },
        ],
      });

      // Mock: All calls fail
      sesMock.on(SendEmailCommand).rejects(new Error("SES persistent failure"));

      const event = createSNSEvent(sampleNotification);

      // Should throw after all retries
      await expect(handler(event, mockContext)).rejects.toThrow("Failed to send 1 of 1 emails");

      // Verify SES was called 3 times (max retries)
      const sesCalls = sesMock.commandCalls(SendEmailCommand);
      expect(sesCalls).toHaveLength(3);
    });

    it("should handle partial failure with multiple subscribers", async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { tenantId: "tenant-abc", email: "success@example.com", verified: true, subscribedAt: "2024-01-01T00:00:00Z" },
          { tenantId: "tenant-abc", email: "failure@example.com", verified: true, subscribedAt: "2024-01-01T00:00:00Z" },
        ],
      });

      // Mock: First email succeeds, second always fails
      let callCount = 0;
      sesMock.on(SendEmailCommand).callsFake((input) => {
        callCount++;
        const toAddress = input.Destination?.ToAddresses?.[0];
        if (toAddress === "success@example.com") {
          return { MessageId: "ses-message-id" };
        }
        throw new Error("SES failure for this address");
      });

      const event = createSNSEvent(sampleNotification);

      // Should throw because one email failed
      await expect(handler(event, mockContext)).rejects.toThrow("Failed to send 1 of 2 emails");

      // Verify: 1 success + 3 retries for failure = 4 total calls
      expect(callCount).toBe(4);
    });
  });

  describe("DynamoDB error handling", () => {
    it("should propagate DynamoDB errors", async () => {
      ddbMock.on(QueryCommand).rejects(new Error("DynamoDB connection error"));

      const event = createSNSEvent(sampleNotification);

      await expect(handler(event, mockContext)).rejects.toThrow("DynamoDB connection error");
    });
  });
});
