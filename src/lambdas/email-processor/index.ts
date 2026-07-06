/**
 * Email Processor Lambda
 * Processes job completion notifications from SNS and sends emails via SES
 * 
 * Requirements:
 * - 3.3: Query email-subscriptions table for tenant subscribers
 * - 3.4: Send emails via SES with job details
 * - 3.6: Implement retry with exponential backoff (up to 3 retries)
 */

import { SNSEvent, SNSEventRecord, Context } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import type { JobCompletionNotification } from "../../shared/types";

// Environment variables
const EMAIL_SUBSCRIPTIONS_TABLE = process.env.EMAIL_SUBSCRIPTIONS_TABLE!;
const SES_FROM_EMAIL = process.env.SES_FROM_EMAIL || "noreply@fleet-tracking.local";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// AWS SDK clients
const ddbClient = new DynamoDBClient({});
const ddb = DynamoDBDocumentClient.from(ddbClient);
const sesClient = new SESClient({});

interface LogData {
  level: "INFO" | "ERROR" | "WARN";
  message: string;
  timestamp: string;
  requestId?: string;
  jobId?: string;
  vehicleId?: string;
  tenantId?: string;
  email?: string;
  attempt?: number;
  errorName?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

interface EmailSubscription {
  tenantId: string;
  email: string;
  subscribedAt: string;
  verified: boolean;
}

// Structured logging
function log(level: "INFO" | "ERROR" | "WARN", message: string, data?: Partial<LogData>): void {
  const logEntry: LogData = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...data,
  };
  console.log(JSON.stringify(logEntry));
}

// Exponential backoff delay
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Requirement 3.3: Query email subscriptions for tenant
async function getVerifiedSubscribers(tenantId: string): Promise<EmailSubscription[]> {
  log("INFO", "Querying email subscriptions", { tenantId });
  
  const result = await ddb.send(new QueryCommand({
    TableName: EMAIL_SUBSCRIPTIONS_TABLE,
    KeyConditionExpression: "tenantId = :tenantId",
    FilterExpression: "verified = :verified",
    ExpressionAttributeValues: {
      ":tenantId": tenantId,
      ":verified": true,
    },
  }));

  const subscribers = (result.Items || []) as EmailSubscription[];
  log("INFO", "Found verified subscribers", { tenantId, count: subscribers.length });
  return subscribers;
}

// Requirement 3.4: Send email via SES with job details
async function sendEmail(
  toEmail: string,
  notification: JobCompletionNotification,
  requestId: string
): Promise<void> {
  const subject = `Job Completed: ${notification.jobId}`;
  const body = `
Job Completion Notification

Job ID: ${notification.jobId}
Vehicle ID: ${notification.vehicleId}
Destination: ${notification.destination}
Completed At: ${notification.completedAt}

This is an automated notification from the Fleet Tracking Platform.
  `.trim();

  await sesClient.send(new SendEmailCommand({
    Source: SES_FROM_EMAIL,
    Destination: {
      ToAddresses: [toEmail],
    },
    Message: {
      Subject: { Data: subject },
      Body: {
        Text: { Data: body },
      },
    },
  }));

  log("INFO", "Email sent successfully", {
    requestId,
    email: toEmail,
    jobId: notification.jobId,
  });
}

// Requirement 3.6: Send email with retry and exponential backoff
async function sendEmailWithRetry(
  toEmail: string,
  notification: JobCompletionNotification,
  requestId: string
): Promise<boolean> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await sendEmail(toEmail, notification, requestId);
      return true;
    } catch (error: unknown) {
      const err = error as { name?: string; message?: string };
      log("WARN", "Email send attempt failed", {
        requestId,
        email: toEmail,
        jobId: notification.jobId,
        attempt,
        errorName: err.name,
        errorMessage: err.message,
      });

      if (attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        log("INFO", "Retrying after delay", { requestId, email: toEmail, delayMs: delay, attempt });
        await sleep(delay);
      }
    }
  }

  log("ERROR", "All email send attempts failed", {
    requestId,
    email: toEmail,
    jobId: notification.jobId,
    maxRetries: MAX_RETRIES,
  });
  return false;
}

// Process a single SNS record
async function processRecord(record: SNSEventRecord, requestId: string): Promise<void> {
  const notification: JobCompletionNotification = JSON.parse(record.Sns.Message);
  
  log("INFO", "Processing job completion notification", {
    requestId,
    jobId: notification.jobId,
    vehicleId: notification.vehicleId,
    tenantId: notification.tenantId,
  });

  // Get verified subscribers for the tenant
  const subscribers = await getVerifiedSubscribers(notification.tenantId);
  
  if (subscribers.length === 0) {
    log("INFO", "No verified subscribers for tenant, skipping email", {
      requestId,
      tenantId: notification.tenantId,
      jobId: notification.jobId,
    });
    return;
  }

  // Send emails to all verified subscribers
  const results = await Promise.all(
    subscribers.map((sub) => sendEmailWithRetry(sub.email, notification, requestId))
  );

  const successCount = results.filter(Boolean).length;
  const failCount = results.length - successCount;

  log("INFO", "Email processing completed", {
    requestId,
    jobId: notification.jobId,
    tenantId: notification.tenantId,
    totalSubscribers: subscribers.length,
    successCount,
    failCount,
  });

  // If any emails failed after all retries, throw to trigger SNS retry/DLQ
  if (failCount > 0) {
    throw new Error(`Failed to send ${failCount} of ${subscribers.length} emails`);
  }
}

export const handler = async (event: SNSEvent, context: Context): Promise<void> => {
  const requestId = context.awsRequestId;
  
  log("INFO", "Email processor invoked", {
    requestId,
    recordCount: event.Records.length,
  });

  // Process each record
  for (const record of event.Records) {
    try {
      await processRecord(record, requestId);
    } catch (error: unknown) {
      const err = error as { name?: string; message?: string };
      log("ERROR", "Failed to process record", {
        requestId,
        messageId: record.Sns.MessageId,
        errorName: err.name,
        errorMessage: err.message,
      });
      // Re-throw to let SNS handle retry via DLQ
      throw error;
    }
  }

  log("INFO", "Email processor completed successfully", {
    requestId,
    recordCount: event.Records.length,
  });
};
