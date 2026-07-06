/**
 * Vehicle API Lambda Handler
 * REST API for vehicle CRUD operations and job management
 *
 * Requirements: 3.4, 3.5, 5.3, 5.7, 5.9, 5.10, 8.9
 * - GET /vehicles - List all vehicles with current state
 * - GET /vehicles/{id} - Get single vehicle details
 * - GET /vehicles/{id}/history - Get vehicle GPS history (last 24h)
 * - GET /vehicles/{id}/eta - Calculate ETA to destination address
 * - POST /jobs - Create new job/dispatch assignment
 * - GET /jobs - List jobs
 * - PUT /jobs/{id} - Update job status
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  QueryCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  LocationClient,
  SearchPlaceIndexForTextCommand,
  CalculateRouteCommand,
  PutGeofenceCommand,
} from "@aws-sdk/client-location";
import { IoTDataPlaneClient, PublishCommand } from "@aws-sdk/client-iot-data-plane";
import { randomUUID } from "crypto";
import type {
  VehicleState,
  DispatchAssignment,
  GpsHistoryRecord,
  CreateJobRequest,
  CreateJobResponse,
  VehicleListResponse,
  VehicleDetailResponse,
  VehicleHistoryResponse,
  EtaResponse,
  JobListResponse,
  JobStatus,
} from "../../shared/types";

// Initialize clients
const ddbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(ddbClient);
const locationClient = new LocationClient({});
const iotDataClient = new IoTDataPlaneClient({});

// Environment variables
const VEHICLE_STATE_TABLE = process.env.VEHICLE_STATE_TABLE!;
const DISPATCH_TABLE = process.env.DISPATCH_TABLE!;
const GPS_HISTORY_TABLE = process.env.GPS_HISTORY_TABLE!;
const PLACE_INDEX_NAME = process.env.PLACE_INDEX_NAME!;
const ROUTE_CALCULATOR_NAME = process.env.ROUTE_CALCULATOR_NAME!;
const GEOFENCE_COLLECTION_NAME = process.env.GEOFENCE_COLLECTION_NAME!;
const EMAIL_SUBSCRIPTIONS_TABLE = process.env.EMAIL_SUBSCRIPTIONS_TABLE;

// Geofence radius in meters for job sites
const JOB_SITE_GEOFENCE_RADIUS = 100;

/**
 * Main Lambda handler - routes requests to appropriate handlers
 */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log("Request:", JSON.stringify({
    httpMethod: event.httpMethod,
    path: event.path,
    pathParameters: event.pathParameters,
    queryStringParameters: event.queryStringParameters,
  }));

  try {
    const { httpMethod, path, pathParameters } = event;
    
    // Task 13.4: Extract tenantId for all requests (Requirements 12.3, 12.4)
    const tenantId = extractTenantId(event);

    // Route: GET /vehicles
    if (httpMethod === "GET" && path === "/vehicles") {
      return await listVehicles(tenantId);
    }

    // Route: GET /vehicles/{id}
    if (httpMethod === "GET" && path.match(/^\/vehicles\/[^/]+$/) && pathParameters?.id) {
      return await getVehicle(pathParameters.id, tenantId);
    }

    // Route: GET /vehicles/{id}/history
    if (httpMethod === "GET" && path.match(/^\/vehicles\/[^/]+\/history$/) && pathParameters?.id) {
      const hours = event.queryStringParameters?.hours
        ? parseInt(event.queryStringParameters.hours, 10)
        : 24;
      return await getVehicleHistory(pathParameters.id, hours, tenantId);
    }

    // Route: GET /vehicles/{id}/eta
    // Requirements: 3.4, 3.5, 5.7, 5.10 - Calculate ETA to destination address
    if (httpMethod === "GET" && path.match(/^\/vehicles\/[^/]+\/eta$/) && pathParameters?.id) {
      const destination = event.queryStringParameters?.destination;
      if (!destination) {
        return response(400, {
          error: "Bad Request",
          message: "destination query parameter is required",
        });
      }
      return await calculateEta(pathParameters.id, destination, tenantId);
    }

    // Route: POST /jobs
    if (httpMethod === "POST" && path === "/jobs") {
      const body = JSON.parse(event.body || "{}") as CreateJobRequest;
      return await createJob(body, tenantId);
    }

    // Route: GET /jobs
    if (httpMethod === "GET" && path === "/jobs") {
      const status = event.queryStringParameters?.status as JobStatus | undefined;
      const vehicleId = event.queryStringParameters?.vehicleId;
      return await listJobs(status, vehicleId, tenantId);
    }

    // Route: PUT /jobs/{id}
    if (httpMethod === "PUT" && path.match(/^\/jobs\/[^/]+$/) && pathParameters?.id) {
      const body = JSON.parse(event.body || "{}");
      return await updateJob(pathParameters.id, body, tenantId);
    }

    // Route: POST /subscriptions/email - Subscribe to notifications (Task 6.1)
    // Requirements: 3.7
    if (httpMethod === "POST" && path === "/subscriptions/email") {
      const body = JSON.parse(event.body || "{}");
      return await subscribeEmail(tenantId, body);
    }

    // Route: DELETE /subscriptions/email - Unsubscribe from notifications (Task 6.1)
    // Requirements: 3.7
    if (httpMethod === "DELETE" && path === "/subscriptions/email") {
      const body = JSON.parse(event.body || "{}");
      return await unsubscribeEmail(tenantId, body);
    }

    // Route not found
    return response(404, { error: "Not Found", message: `Route ${httpMethod} ${path} not found` });
  } catch (error) {
    console.error("Error:", error);
    return response(500, {
      error: "Internal Server Error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/**
 * GET /vehicles - List all vehicles with current state
 * Task 13.4: Filter by tenantId (Requirements 12.3)
 */
async function listVehicles(tenantId: string): Promise<APIGatewayProxyResult> {
  // Task 13.4: Use GSI to query by tenantId for tenant-scoped results
  // For demo, we scan and filter. In production, use tenantId-index GSI
  const result = await docClient.send(
    new ScanCommand({
      TableName: VEHICLE_STATE_TABLE,
      FilterExpression: "tenantId = :tenantId OR attribute_not_exists(tenantId)",
      ExpressionAttributeValues: {
        ":tenantId": tenantId,
      },
    })
  );

  const vehicles = (result.Items || []) as VehicleState[];

  const responseBody: VehicleListResponse = {
    vehicles,
    count: vehicles.length,
  };

  return response(200, responseBody);
}

/**
 * GET /vehicles/{id} - Get single vehicle details with current job
 * Task 13.4: Verify tenant access (Requirements 12.3, 12.5)
 */
async function getVehicle(vehicleId: string, tenantId: string): Promise<APIGatewayProxyResult> {
  // Get vehicle state
  const vehicleResult = await docClient.send(
    new GetCommand({
      TableName: VEHICLE_STATE_TABLE,
      Key: { vehicleId },
    })
  );

  if (!vehicleResult.Item) {
    return response(404, { error: "Not Found", message: `Vehicle ${vehicleId} not found` });
  }

  const vehicle = vehicleResult.Item as VehicleState;

  // Task 13.4: Verify tenant access (Requirement 12.5)
  // Return 403 Forbidden for cross-tenant access attempts
  if (vehicle.tenantId && vehicle.tenantId !== tenantId) {
    return response(403, {
      error: "Forbidden",
      message: "Access denied to this vehicle",
    });
  }

  // Get current job if assigned
  let currentJob: DispatchAssignment | undefined;
  if (vehicle.assignedJobId) {
    const jobResult = await docClient.send(
      new QueryCommand({
        TableName: DISPATCH_TABLE,
        KeyConditionExpression: "jobId = :jobId AND vehicleId = :vehicleId",
        ExpressionAttributeValues: {
          ":jobId": vehicle.assignedJobId,
          ":vehicleId": vehicleId,
        },
      })
    );
    currentJob = jobResult.Items?.[0] as DispatchAssignment | undefined;
  }

  const responseBody: VehicleDetailResponse = {
    vehicle,
    currentJob,
  };

  return response(200, responseBody);
}

/**
 * GET /vehicles/{id}/history - Get vehicle GPS history (last 24h by default)
 * Task 13.4: Verify tenant access (Requirements 12.3, 12.5)
 */
async function getVehicleHistory(
  vehicleId: string,
  hours: number = 24,
  tenantId: string
): Promise<APIGatewayProxyResult> {
  // First verify tenant access to this vehicle
  const vehicleResult = await docClient.send(
    new GetCommand({
      TableName: VEHICLE_STATE_TABLE,
      Key: { vehicleId },
    })
  );

  if (!vehicleResult.Item) {
    return response(404, { error: "Not Found", message: `Vehicle ${vehicleId} not found` });
  }

  const vehicle = vehicleResult.Item as VehicleState;

  // Task 13.4: Verify tenant access (Requirement 12.5)
  if (vehicle.tenantId && vehicle.tenantId !== tenantId) {
    return response(403, {
      error: "Forbidden",
      message: "Access denied to this vehicle",
    });
  }

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - hours * 60 * 60 * 1000);

  const result = await docClient.send(
    new QueryCommand({
      TableName: GPS_HISTORY_TABLE,
      KeyConditionExpression: "vehicleId = :vid AND #ts BETWEEN :start AND :end",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: {
        ":vid": vehicleId,
        ":start": startTime.toISOString(),
        ":end": endTime.toISOString(),
      },
      ScanIndexForward: true, // Oldest first
    })
  );

  const positions = (result.Items || []) as GpsHistoryRecord[];

  const responseBody: VehicleHistoryResponse = {
    vehicleId,
    positions,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
  };

  return response(200, responseBody);
}

/**
 * GET /vehicles/{id}/eta - Calculate ETA from vehicle's current position to destination
 * Requirements: 3.4, 3.5, 5.7, 5.10
 * Task 13.4: Verify tenant access (Requirements 12.3, 12.5)
 * - Geocodes destination address using Place Index
 * - Calculates route and ETA using Routes API
 * - Returns ETA with duration and distance
 */
async function calculateEta(
  vehicleId: string,
  destinationAddress: string,
  tenantId: string
): Promise<APIGatewayProxyResult> {
  // Get vehicle's current position
  const vehicleResult = await docClient.send(
    new GetCommand({
      TableName: VEHICLE_STATE_TABLE,
      Key: { vehicleId },
    })
  );

  if (!vehicleResult.Item) {
    return response(404, { error: "Not Found", message: `Vehicle ${vehicleId} not found` });
  }

  const vehicle = vehicleResult.Item as VehicleState;

  // Task 13.4: Verify tenant access (Requirement 12.5)
  if (vehicle.tenantId && vehicle.tenantId !== tenantId) {
    return response(403, {
      error: "Forbidden",
      message: "Access denied to this vehicle",
    });
  }

  if (!vehicle.position) {
    return response(400, {
      error: "Bad Request",
      message: `Vehicle ${vehicleId} has no current position`,
    });
  }

  // Geocode the destination address to coordinates
  // Requirements: 3.5 - Place Index geocodes job addresses to coordinates
  const geocodeResult = await locationClient.send(
    new SearchPlaceIndexForTextCommand({
      IndexName: PLACE_INDEX_NAME,
      Text: destinationAddress,
      MaxResults: 1,
    })
  );

  if (!geocodeResult.Results || geocodeResult.Results.length === 0) {
    return response(400, {
      error: "Bad Request",
      message: `Could not geocode address: ${destinationAddress}`,
    });
  }

  const place = geocodeResult.Results[0].Place!;
  const [lng, lat] = place.Geometry!.Point!;

  // Calculate route and ETA using Routes API
  // Requirements: 3.4 - Routes API calculates ETAs from current vehicle position to job site address
  const routeResult = await locationClient.send(
    new CalculateRouteCommand({
      CalculatorName: ROUTE_CALCULATOR_NAME,
      DeparturePosition: [vehicle.position.lng, vehicle.position.lat],
      DestinationPosition: [lng, lat],
      TravelMode: "Car",
      DepartNow: true,
    })
  );

  if (!routeResult.Summary) {
    return response(500, {
      error: "Internal Server Error",
      message: "Failed to calculate route",
    });
  }

  const durationSeconds = routeResult.Summary.DurationSeconds || 0;
  const distanceMeters = routeResult.Summary.Distance || 0;

  // Convert to user-friendly units
  const durationMinutes = Math.round(durationSeconds / 60);
  const distanceKm = Math.round(distanceMeters * 10) / 10; // Round to 1 decimal
  const eta = new Date(Date.now() + durationSeconds * 1000).toISOString();

  const responseBody: EtaResponse = {
    vehicleId,
    destination: { lat, lng },
    eta,
    durationMinutes,
    distanceKm,
  };

  console.log("ETA calculated:", responseBody);

  return response(200, responseBody);
}

/**
 * POST /jobs - Create new job/dispatch assignment
 * Geocodes address, calculates ETA, creates geofence for auto-arrival
 * 
 * Task 6.3: Check vehicle availability before job assignment
 * Task 6.5: Validate geofence coordinates
 * Task 13.2: Set tenantId on job creation (Requirements 12.2, 12.4)
 */
async function createJob(request: CreateJobRequest, tenantId: string): Promise<APIGatewayProxyResult> {
  const { address, vehicleId, description } = request;

  // Validate required fields
  if (!address || !vehicleId) {
    return response(400, {
      error: "Bad Request",
      message: "address and vehicleId are required",
    });
  }

  // Verify vehicle exists
  const vehicleResult = await docClient.send(
    new GetCommand({
      TableName: VEHICLE_STATE_TABLE,
      Key: { vehicleId },
    })
  );

  if (!vehicleResult.Item) {
    return response(404, { error: "Not Found", message: `Vehicle ${vehicleId} not found` });
  }

  const vehicle = vehicleResult.Item as VehicleState;

  // Task 13.4: Verify tenant access to vehicle (Requirement 12.5)
  if (vehicle.tenantId && vehicle.tenantId !== tenantId) {
    return response(403, {
      error: "Forbidden",
      message: "Access denied to this vehicle",
    });
  }

  // Task 6.3: Check vehicle availability (Requirements 4.7, 4.8)
  // Vehicle must be "available" to accept new jobs
  if (vehicle.status !== "available") {
    return response(400, {
      error: "Bad Request",
      message: `Vehicle ${vehicleId} is not available for job assignment. Current status: ${vehicle.status}`,
    });
  }

  if (vehicle.assignedJobId) {
    return response(400, {
      error: "Bad Request",
      message: `Vehicle ${vehicleId} already has an assigned job: ${vehicle.assignedJobId}`,
    });
  }

  // Geocode the address to coordinates
  const geocodeResult = await locationClient.send(
    new SearchPlaceIndexForTextCommand({
      IndexName: PLACE_INDEX_NAME,
      Text: address,
      MaxResults: 1,
    })
  );

  if (!geocodeResult.Results || geocodeResult.Results.length === 0) {
    return response(400, {
      error: "Bad Request",
      message: `Could not geocode address: ${address}`,
    });
  }

  const place = geocodeResult.Results[0].Place!;
  const [lng, lat] = place.Geometry!.Point!;

  // Task 6.5: Validate geofence coordinates (Requirement 5.4)
  const coordValidation = validateCoordinates(lat, lng);
  if (!coordValidation.valid) {
    return response(400, {
      error: "Bad Request",
      message: `Invalid coordinates from geocoding: ${coordValidation.error}`,
    });
  }

  const coordinates = { lat, lng };

  // Calculate ETA from vehicle's current position to job site
  let eta: string | undefined;
  let distanceKm: number | undefined;

  if (vehicle.position) {
    try {
      const routeResult = await locationClient.send(
        new CalculateRouteCommand({
          CalculatorName: ROUTE_CALCULATOR_NAME,
          DeparturePosition: [vehicle.position.lng, vehicle.position.lat],
          DestinationPosition: [lng, lat],
          TravelMode: "Car",
          DepartNow: true,
        })
      );

      if (routeResult.Summary) {
        const durationSeconds = routeResult.Summary.DurationSeconds || 0;
        const distanceMeters = routeResult.Summary.Distance || 0;

        eta = new Date(Date.now() + durationSeconds * 1000).toISOString();
        distanceKm = Math.round(distanceMeters * 10) / 10; // Round to 1 decimal
      }
    } catch (routeError) {
      console.warn("Failed to calculate route:", routeError);
      // Continue without ETA - not a fatal error
    }
  }

  // Generate job ID and geofence ID
  const jobId = randomUUID();
  const geofenceId = `job-${jobId}`;

  // Create geofence at job site for auto-arrival detection
  // Requirements: 3.7 - Geofence (100m radius) auto-created when job is assigned
  await locationClient.send(
    new PutGeofenceCommand({
      CollectionName: GEOFENCE_COLLECTION_NAME,
      GeofenceId: geofenceId,
      Geometry: {
        Circle: {
          Center: [lng, lat],
          Radius: JOB_SITE_GEOFENCE_RADIUS,
        },
      },
    })
  );

  const now = new Date().toISOString();

  // Create dispatch assignment record
  // Task 13.2: Set tenantId from authenticated user's claims (Requirement 12.2, 12.4)
  const assignment: DispatchAssignment = {
    jobId,
    vehicleId,
    address: place.Label || address,
    coordinates,
    status: "en-route",
    geofenceId,
    eta,
    distanceKm,
    createdAt: now,
    tenantId, // Task 13.2: Include tenantId on job creation
  };

  await docClient.send(
    new PutCommand({
      TableName: DISPATCH_TABLE,
      Item: assignment,
    })
  );

  // Update vehicle state to en-route with assigned job
  await docClient.send(
    new UpdateCommand({
      TableName: VEHICLE_STATE_TABLE,
      Key: { vehicleId },
      UpdateExpression: "SET #status = :status, assignedJobId = :jobId",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": "en-route",
        ":jobId": jobId,
      },
    })
  );

  // Publish job command to vehicle via IoT Core
  // This tells the simulator to start moving toward the destination
  const jobCommand = {
    action: "ASSIGN",
    jobId,
    destination: {
      lat,
      lng,
      address: place.Label || address,
    },
  };

  try {
    await iotDataClient.send(
      new PublishCommand({
        topic: `fleet/vehicles/${vehicleId}/commands/job`,
        payload: Buffer.from(JSON.stringify(jobCommand)),
        qos: 1,
      })
    );
    console.log(`Job command published to ${vehicleId}:`, jobCommand);
  } catch (iotError) {
    console.warn("Failed to publish job command to IoT:", iotError);
    // Continue - job is still created, vehicle just won't move automatically
  }

  const responseBody: CreateJobResponse = {
    jobId,
    vehicleId,
    address: assignment.address,
    coordinates,
    eta,
    distanceKm,
    geofenceId,
  };

  console.log("Job created:", responseBody);

  return response(201, responseBody);
}

/**
 * GET /jobs - List jobs with optional filtering
 * Task 13.4: Filter by tenantId (Requirements 12.3)
 */
async function listJobs(
  status?: JobStatus,
  vehicleId?: string,
  tenantId?: string
): Promise<APIGatewayProxyResult> {
  // For demo simplicity, we scan the table
  // In production, use GSIs for efficient queries by status/vehicleId/tenantId
  const result = await docClient.send(
    new ScanCommand({
      TableName: DISPATCH_TABLE,
      FilterExpression: "tenantId = :tenantId OR attribute_not_exists(tenantId)",
      ExpressionAttributeValues: {
        ":tenantId": tenantId,
      },
    })
  );

  let jobs = (result.Items || []) as DispatchAssignment[];

  // Apply filters
  if (status) {
    jobs = jobs.filter((job) => job.status === status);
  }
  if (vehicleId) {
    jobs = jobs.filter((job) => job.vehicleId === vehicleId);
  }

  // Sort by createdAt descending (newest first)
  jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const responseBody: JobListResponse = {
    jobs,
    count: jobs.length,
  };

  return response(200, responseBody);
}

/**
 * PUT /jobs/{id} - Update job status
 * Task 13.4: Verify tenant access (Requirements 12.3, 12.5)
 */
async function updateJob(
  jobId: string,
  updates: { status?: JobStatus; vehicleId?: string },
  tenantId: string
): Promise<APIGatewayProxyResult> {
  const { status, vehicleId } = updates;

  if (!vehicleId) {
    return response(400, {
      error: "Bad Request",
      message: "vehicleId is required to identify the job",
    });
  }

  // Get current job
  const jobResult = await docClient.send(
    new QueryCommand({
      TableName: DISPATCH_TABLE,
      KeyConditionExpression: "jobId = :jobId AND vehicleId = :vehicleId",
      ExpressionAttributeValues: {
        ":jobId": jobId,
        ":vehicleId": vehicleId,
      },
    })
  );

  if (!jobResult.Items || jobResult.Items.length === 0) {
    return response(404, {
      error: "Not Found",
      message: `Job ${jobId} for vehicle ${vehicleId} not found`,
    });
  }

  const job = jobResult.Items[0] as DispatchAssignment;

  // Task 13.4: Verify tenant access (Requirement 12.5)
  if (job.tenantId && job.tenantId !== tenantId) {
    return response(403, {
      error: "Forbidden",
      message: "Access denied to this job",
    });
  }

  // Build update expression
  const updateExpressions: string[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {};

  if (status) {
    updateExpressions.push("#status = :status");
    expressionAttributeNames["#status"] = "status";
    expressionAttributeValues[":status"] = status;

    // If completing the job, set completedAt
    if (status === "completed") {
      updateExpressions.push("completedAt = :completedAt");
      expressionAttributeValues[":completedAt"] = new Date().toISOString();
    }
  }

  if (updateExpressions.length === 0) {
    return response(400, {
      error: "Bad Request",
      message: "No valid updates provided",
    });
  }

  // Update the job
  await docClient.send(
    new UpdateCommand({
      TableName: DISPATCH_TABLE,
      Key: { jobId, vehicleId },
      UpdateExpression: `SET ${updateExpressions.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  // If job is completed or cancelled, update vehicle status
  if (status === "completed" || status === "cancelled") {
    await docClient.send(
      new UpdateCommand({
        TableName: VEHICLE_STATE_TABLE,
        Key: { vehicleId },
        UpdateExpression: "SET #status = :status REMOVE assignedJobId",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":status": "available" },
      })
    );
  }

  // Return updated job
  const updatedJobResult = await docClient.send(
    new QueryCommand({
      TableName: DISPATCH_TABLE,
      KeyConditionExpression: "jobId = :jobId AND vehicleId = :vehicleId",
      ExpressionAttributeValues: {
        ":jobId": jobId,
        ":vehicleId": vehicleId,
      },
    })
  );

  return response(200, updatedJobResult.Items?.[0] || job);
}

/**
 * Extract tenantId from JWT claims or default
 * Requirements: 13.3 - Extract tenantId from JWT token
 */
function extractTenantId(event: APIGatewayProxyEvent): string {
  // Try to get tenantId from Cognito authorizer claims
  const claims = event.requestContext.authorizer?.claims;
  if (claims && claims["custom:tenantId"]) {
    return claims["custom:tenantId"] as string;
  }
  // Fallback to default tenant for demo
  return "default";
}

/**
 * Validate email format
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate geofence coordinates (Task 6.5)
 * Requirements: 5.4 - Validate latitude in range [-90, 90], longitude in range [-180, 180]
 */
function validateCoordinates(lat: number, lng: number): { valid: boolean; error?: string } {
  if (typeof lat !== "number" || isNaN(lat)) {
    return { valid: false, error: "latitude must be a valid number" };
  }
  if (typeof lng !== "number" || isNaN(lng)) {
    return { valid: false, error: "longitude must be a valid number" };
  }
  if (lat < -90 || lat > 90) {
    return { valid: false, error: "latitude must be between -90 and 90" };
  }
  if (lng < -180 || lng > 180) {
    return { valid: false, error: "longitude must be between -180 and 180" };
  }
  return { valid: true };
}

/**
 * POST /subscriptions/email - Subscribe to notifications (Task 6.1)
 * Requirements: 3.7 - Email subscription endpoints
 */
async function subscribeEmail(
  tenantId: string,
  body: { email?: string }
): Promise<APIGatewayProxyResult> {
  const { email } = body;

  if (!email) {
    return response(400, {
      error: "Bad Request",
      message: "email is required",
    });
  }

  if (!isValidEmail(email)) {
    return response(400, {
      error: "Bad Request",
      message: "Invalid email format",
    });
  }

  if (!EMAIL_SUBSCRIPTIONS_TABLE) {
    return response(500, {
      error: "Internal Server Error",
      message: "Email subscriptions not configured",
    });
  }

  const now = new Date().toISOString();

  await docClient.send(
    new PutCommand({
      TableName: EMAIL_SUBSCRIPTIONS_TABLE,
      Item: {
        tenantId,
        email,
        subscribedAt: now,
        verified: true, // For demo, auto-verify. In production, send verification email
      },
    })
  );

  console.log("Email subscription created:", { tenantId, email });

  return response(201, {
    message: "Subscribed successfully",
    email,
    tenantId,
    subscribedAt: now,
  });
}

/**
 * DELETE /subscriptions/email - Unsubscribe from notifications (Task 6.1)
 * Requirements: 3.7 - Email subscription endpoints
 */
async function unsubscribeEmail(
  tenantId: string,
  body: { email?: string }
): Promise<APIGatewayProxyResult> {
  const { email } = body;

  if (!email) {
    return response(400, {
      error: "Bad Request",
      message: "email is required",
    });
  }

  if (!EMAIL_SUBSCRIPTIONS_TABLE) {
    return response(500, {
      error: "Internal Server Error",
      message: "Email subscriptions not configured",
    });
  }

  await docClient.send(
    new DeleteCommand({
      TableName: EMAIL_SUBSCRIPTIONS_TABLE,
      Key: {
        tenantId,
        email,
      },
    })
  );

  console.log("Email subscription deleted:", { tenantId, email });

  return response(200, {
    message: "Unsubscribed successfully",
    email,
    tenantId,
  });
}

/**
 * Helper function to create API Gateway response
 * Note: CORS origin is set to "*" for demo purposes. In production,
 * restrict this to your CloudFront domain (e.g., "https://d1234.cloudfront.net").
 */
function response(statusCode: number, body: unknown): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}
