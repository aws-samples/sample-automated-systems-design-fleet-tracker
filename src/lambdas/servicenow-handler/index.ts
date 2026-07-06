/**
 * ServiceNow Handler Lambda
 * 
 * Tasks 24-27: ServiceNow Integration for incident management
 * Requirements: 20.1-20.6, 21.1-21.5, 22.1-22.5
 * 
 * Handles:
 * - System error incidents from CloudWatch alarms
 * - Overdue job escalation
 * - Stale vehicle alerts
 * - Incident deduplication and resolution
 */

import { SNSHandler, ScheduledHandler, APIGatewayProxyHandler, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const dynamoClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dynamoClient);
const secretsClient = new SecretsManagerClient({});

const INCIDENTS_TABLE = process.env.INCIDENTS_TABLE!;
const DISPATCH_TABLE = process.env.DISPATCH_TABLE!;
const VEHICLE_STATE_TABLE = process.env.VEHICLE_STATE_TABLE!;
const SERVICENOW_SECRET_ARN = process.env.SERVICENOW_SECRET_ARN!;

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

interface ServiceNowCredentials {
  instanceUrl: string;
  username: string;
  password: string;
}

interface ServiceNowIncident {
  short_description: string;
  description: string;
  urgency: string;
  impact: string;
  category?: string;
  subcategory?: string;
  caller_id?: string;
}

interface IncidentRecord {
  incidentKey: string;
  sysId?: string;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt?: string;
  ttl: number;
}

// Utility functions
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getCredentials(): Promise<ServiceNowCredentials> {
  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: SERVICENOW_SECRET_ARN })
  );
  return JSON.parse(response.SecretString!);
}

async function withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      console.warn(`Attempt ${attempt + 1} failed:`, error);
      if (attempt < retries - 1) {
        await sleep(RETRY_DELAY_MS * Math.pow(2, attempt));
      }
    }
  }
  throw lastError;
}

// ServiceNow REST API client (Task 24.3)
async function createIncident(incident: ServiceNowIncident): Promise<string> {
  const creds = await getCredentials();
  
  return withRetry(async () => {
    const response = await fetch(`${creds.instanceUrl}/api/now/table/incident`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`,
      },
      body: JSON.stringify(incident),
    });

    if (!response.ok) {
      throw new Error(`ServiceNow API error: ${response.status}`);
    }

    const data = await response.json() as { result: { sys_id: string } };
    return data.result.sys_id;
  });
}

async function updateIncident(sysId: string, updates: Partial<ServiceNowIncident> & { state?: string }): Promise<void> {
  const creds = await getCredentials();
  
  return withRetry(async () => {
    const response = await fetch(`${creds.instanceUrl}/api/now/table/incident/${sysId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString("base64")}`,
      },
      body: JSON.stringify(updates),
    });

    if (!response.ok) {
      throw new Error(`ServiceNow API error: ${response.status}`);
    }
  });
}

// Incident deduplication (Task 26.4)
async function checkExistingIncident(incidentKey: string): Promise<IncidentRecord | null> {
  const result = await docClient.send(
    new GetCommand({
      TableName: INCIDENTS_TABLE,
      Key: { incidentKey },
    })
  );
  return result.Item as IncidentRecord | null;
}

async function recordIncident(incidentKey: string, sysId: string): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days
  await docClient.send(
    new PutCommand({
      TableName: INCIDENTS_TABLE,
      Item: {
        incidentKey,
        sysId,
        status: "open",
        createdAt: new Date().toISOString(),
        ttl,
      },
    })
  );
}

async function resolveIncidentRecord(incidentKey: string): Promise<string | null> {
  const existing = await checkExistingIncident(incidentKey);
  if (!existing || existing.status === "resolved") {
    return null;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: INCIDENTS_TABLE,
      Key: { incidentKey },
      UpdateExpression: "SET #status = :status, resolvedAt = :resolvedAt",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "resolved",
        ":resolvedAt": new Date().toISOString(),
      },
    })
  );

  return existing.sysId || null;
}

/**
 * Task 25: System Error Incidents - SNS Handler for CloudWatch Alarms
 */
export const alarmHandler: SNSHandler = async (event) => {
  console.log("Processing CloudWatch alarm:", JSON.stringify(event));

  for (const record of event.Records) {
    const message = JSON.parse(record.Sns.Message);
    const alarmName = message.AlarmName;
    const alarmDescription = message.AlarmDescription || "No description";
    const newState = message.NewStateValue;

    if (newState !== "ALARM") {
      console.log("Ignoring non-ALARM state:", newState);
      continue;
    }

    const incidentKey = `alarm-${alarmName}`;
    const existing = await checkExistingIncident(incidentKey);
    
    if (existing && existing.status === "open") {
      console.log("Incident already exists for alarm:", alarmName);
      continue;
    }

    const incident: ServiceNowIncident = {
      short_description: `Fleet Tracking Alert: ${alarmName}`,
      description: `CloudWatch Alarm triggered:\n\nAlarm: ${alarmName}\nDescription: ${alarmDescription}\nState: ${newState}\nTime: ${message.StateChangeTime}`,
      urgency: "2", // Medium
      impact: "2", // Medium
      category: "Software",
      subcategory: "Application",
    };

    try {
      const sysId = await createIncident(incident);
      await recordIncident(incidentKey, sysId);
      console.log("Created incident for alarm:", alarmName, "sysId:", sysId);
    } catch (error) {
      console.error("Failed to create incident:", error);
      throw error;
    }
  }
};

/**
 * Task 26: Overdue Job Detection - Scheduled Handler
 */
export const overdueJobHandler: ScheduledHandler = async () => {
  console.log("Checking for overdue jobs");

  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();

  // Find jobs in "en-route" status for more than 2 hours
  const result = await docClient.send(
    new ScanCommand({
      TableName: DISPATCH_TABLE,
      FilterExpression: "#status = :status AND createdAt < :threshold",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "en-route",
        ":threshold": twoHoursAgo,
      },
    })
  );

  const overdueJobs = result.Items || [];
  console.log(`Found ${overdueJobs.length} overdue jobs`);

  for (const job of overdueJobs) {
    const incidentKey = `overdue-job-${job.jobId}`;
    const existing = await checkExistingIncident(incidentKey);

    if (existing && existing.status === "open") {
      console.log("Incident already exists for job:", job.jobId);
      continue;
    }

    // Determine urgency based on duration (Task 26.2)
    const isHighUrgency = job.createdAt < fourHoursAgo;
    
    // Get current vehicle position
    const vehicleResult = await docClient.send(
      new GetCommand({
        TableName: VEHICLE_STATE_TABLE,
        Key: { vehicleId: job.vehicleId },
      })
    );
    const vehicle = vehicleResult.Item;

    const incident: ServiceNowIncident = {
      short_description: `Overdue Job: ${job.jobId}`,
      description: `Job has been in en-route status for more than ${isHighUrgency ? "4" : "2"} hours.\n\n` +
        `Job ID: ${job.jobId}\n` +
        `Vehicle ID: ${job.vehicleId}\n` +
        `Dispatch Time: ${job.createdAt}\n` +
        `Destination: ${job.address}\n` +
        `Current Position: ${vehicle?.position ? `${vehicle.position.lat}, ${vehicle.position.lng}` : "Unknown"}`,
      urgency: isHighUrgency ? "1" : "2", // High or Medium
      impact: "2", // Medium
      category: "Operations",
    };

    try {
      const sysId = await createIncident(incident);
      await recordIncident(incidentKey, sysId);
      console.log("Created incident for overdue job:", job.jobId);
    } catch (error) {
      console.error("Failed to create incident for job:", job.jobId, error);
    }
  }
};

/**
 * Task 27: Stale Vehicle Detection - Scheduled Handler
 */
export const staleVehicleHandler: ScheduledHandler = async () => {
  console.log("Checking for stale vehicles");

  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  // Find vehicles in "en-route" status with no GPS update in 10 minutes
  const result = await docClient.send(
    new ScanCommand({
      TableName: VEHICLE_STATE_TABLE,
      FilterExpression: "#status = :status AND lastSeen < :threshold",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "en-route",
        ":threshold": tenMinutesAgo,
      },
    })
  );

  const staleVehicles = result.Items || [];
  console.log(`Found ${staleVehicles.length} stale vehicles`);

  for (const vehicle of staleVehicles) {
    const incidentKey = `stale-vehicle-${vehicle.vehicleId}`;
    const existing = await checkExistingIncident(incidentKey);

    if (existing && existing.status === "open") {
      console.log("Incident already exists for vehicle:", vehicle.vehicleId);
      continue;
    }

    // Get assigned job details
    let jobDetails = "No assigned job";
    if (vehicle.assignedJobId) {
      const jobResult = await docClient.send(
        new QueryCommand({
          TableName: DISPATCH_TABLE,
          KeyConditionExpression: "jobId = :jobId",
          ExpressionAttributeValues: { ":jobId": vehicle.assignedJobId },
        })
      );
      if (jobResult.Items && jobResult.Items.length > 0) {
        const job = jobResult.Items[0];
        jobDetails = `Job ID: ${job.jobId}, Destination: ${job.address}`;
      }
    }

    const incident: ServiceNowIncident = {
      short_description: `Stale Vehicle: ${vehicle.vehicleId}`,
      description: `Vehicle has not reported GPS position for more than 10 minutes while en-route.\n\n` +
        `Vehicle ID: ${vehicle.vehicleId}\n` +
        `Last Known Position: ${vehicle.position ? `${vehicle.position.lat}, ${vehicle.position.lng}` : "Unknown"}\n` +
        `Last Update: ${vehicle.lastSeen}\n` +
        `Assigned Job: ${jobDetails}`,
      urgency: "2", // Medium
      impact: "2", // Medium
      category: "Operations",
    };

    try {
      const sysId = await createIncident(incident);
      await recordIncident(incidentKey, sysId);
      console.log("Created incident for stale vehicle:", vehicle.vehicleId);
    } catch (error) {
      console.error("Failed to create incident for vehicle:", vehicle.vehicleId, error);
    }
  }
};

/**
 * Task 26.6: Resolve incident on job completion
 */
export async function resolveJobIncident(jobId: string): Promise<void> {
  const incidentKey = `overdue-job-${jobId}`;
  const sysId = await resolveIncidentRecord(incidentKey);
  
  if (sysId) {
    try {
      await updateIncident(sysId, {
        state: "6", // Resolved
        description: `Job completed at ${new Date().toISOString()}`,
      });
      console.log("Resolved ServiceNow incident for job:", jobId);
    } catch (error) {
      console.error("Failed to resolve ServiceNow incident:", error);
    }
  }
}

/**
 * Task 27.4: Resolve vehicle alert when vehicle resumes updates
 */
export async function resolveVehicleAlert(vehicleId: string): Promise<void> {
  const incidentKey = `stale-vehicle-${vehicleId}`;
  const sysId = await resolveIncidentRecord(incidentKey);
  
  if (sysId) {
    try {
      await updateIncident(sysId, {
        state: "6", // Resolved
        description: `Vehicle resumed GPS updates at ${new Date().toISOString()}`,
      });
      console.log("Resolved ServiceNow incident for vehicle:", vehicleId);
    } catch (error) {
      console.error("Failed to resolve ServiceNow incident:", error);
    }
  }
}

/**
 * Task 27.6: Manual incident creation from dashboard
 */
export const manualIncidentHandler: APIGatewayProxyHandler = async (event): Promise<APIGatewayProxyResult> => {
  console.log("Manual incident creation request");

  try {
    const body = JSON.parse(event.body || "{}");
    const { vehicleId, description, urgency = "2" } = body;

    if (!vehicleId || !description) {
      return {
        statusCode: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "vehicleId and description are required" }),
      };
    }

    const incidentKey = `manual-${vehicleId}-${Date.now()}`;

    const incident: ServiceNowIncident = {
      short_description: `Dispatcher Report: ${vehicleId}`,
      description: `Manual incident reported by dispatcher:\n\n${description}`,
      urgency,
      impact: "2",
      category: "Operations",
    };

    const sysId = await createIncident(incident);
    await recordIncident(incidentKey, sysId);

    return {
      statusCode: 201,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ incidentKey, sysId }),
    };
  } catch (error) {
    console.error("Failed to create manual incident:", error);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Failed to create incident" }),
    };
  }
};
