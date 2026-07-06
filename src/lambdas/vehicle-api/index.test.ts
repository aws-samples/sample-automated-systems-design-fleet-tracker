import { APIGatewayProxyEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
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

// Set environment variables BEFORE importing handler
process.env.VEHICLE_STATE_TABLE = "vehicle-current-state";
process.env.DISPATCH_TABLE = "dispatch-assignments";
process.env.GPS_HISTORY_TABLE = "gps-history";
process.env.PLACE_INDEX_NAME = "fleet-places";
process.env.ROUTE_CALCULATOR_NAME = "fleet-routes";
process.env.GEOFENCE_COLLECTION_NAME = "job-sites";
process.env.EMAIL_SUBSCRIPTIONS_TABLE = "email-subscriptions";

// Import handler AFTER setting environment variables
import { handler } from "./index";

// Mock AWS clients
const ddbMock = mockClient(DynamoDBDocumentClient);
const locationMock = mockClient(LocationClient);

// Helper to create API Gateway event
function createEvent(
  httpMethod: string,
  path: string,
  options: {
    pathParameters?: Record<string, string>;
    queryStringParameters?: Record<string, string>;
    body?: object;
  } = {}
): APIGatewayProxyEvent {
  return {
    httpMethod,
    path,
    pathParameters: options.pathParameters || null,
    queryStringParameters: options.queryStringParameters || null,
    body: options.body ? JSON.stringify(options.body) : null,
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    stageVariables: null,
    requestContext: {} as any,
    resource: "",
    multiValueQueryStringParameters: null,
  };
}

// Sample data
const sampleVehicle = {
  vehicleId: "vehicle-001",
  position: { lat: 37.7749, lng: -122.4194 },
  heading: 180,
  speed: 35,
  ignition: true,
  status: "available",
  lastSeen: "2024-03-15T10:30:00Z",
};

const sampleJob = {
  jobId: "job-123",
  vehicleId: "vehicle-001",
  address: "123 Main St, San Francisco, CA",
  coordinates: { lat: 37.7849, lng: -122.4094 },
  status: "en-route",
  createdAt: "2024-03-15T10:00:00Z",
};

describe("Vehicle API Lambda", () => {
  beforeEach(() => {
    ddbMock.reset();
    locationMock.reset();
    jest.clearAllMocks();
  });

  describe("GET /vehicles", () => {
    it("should return list of all vehicles", async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [sampleVehicle, { ...sampleVehicle, vehicleId: "vehicle-002" }],
      });

      const event = createEvent("GET", "/vehicles");
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.vehicles).toHaveLength(2);
      expect(body.count).toBe(2);
    });

    it("should return empty list when no vehicles exist", async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] });

      const event = createEvent("GET", "/vehicles");
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.vehicles).toHaveLength(0);
      expect(body.count).toBe(0);
    });
  });

  describe("GET /vehicles/{id}", () => {
    it("should return vehicle details", async () => {
      ddbMock.on(GetCommand).resolves({ Item: sampleVehicle });

      const event = createEvent("GET", "/vehicles/vehicle-001", {
        pathParameters: { id: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.vehicle.vehicleId).toBe("vehicle-001");
    });

    it("should return 404 for non-existent vehicle", async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = createEvent("GET", "/vehicles/unknown", {
        pathParameters: { id: "unknown" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.error).toBe("Not Found");
    });

    it("should include current job if assigned", async () => {
      const vehicleWithJob = { ...sampleVehicle, assignedJobId: "job-123" };
      ddbMock.on(GetCommand).resolves({ Item: vehicleWithJob });
      ddbMock.on(QueryCommand).resolves({ Items: [sampleJob] });

      const event = createEvent("GET", "/vehicles/vehicle-001", {
        pathParameters: { id: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.currentJob).toBeDefined();
      expect(body.currentJob.jobId).toBe("job-123");
    });
  });

  describe("GET /vehicles/{id}/history", () => {
    it("should return GPS history for vehicle", async () => {
      const historyPoints = [
        { vehicleId: "vehicle-001", timestamp: "2024-03-15T09:00:00Z", position: { lat: 37.77, lng: -122.41 } },
        { vehicleId: "vehicle-001", timestamp: "2024-03-15T10:00:00Z", position: { lat: 37.78, lng: -122.42 } },
      ];
      // First call is GetCommand for vehicle tenant check, second is QueryCommand for history
      ddbMock.on(GetCommand).resolves({ Item: sampleVehicle });
      ddbMock.on(QueryCommand).resolves({ Items: historyPoints });

      const event = createEvent("GET", "/vehicles/vehicle-001/history", {
        pathParameters: { id: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.vehicleId).toBe("vehicle-001");
      expect(body.positions).toHaveLength(2);
    });
  });

  describe("GET /vehicles/{id}/eta", () => {
    it("should calculate ETA to destination", async () => {
      ddbMock.on(GetCommand).resolves({ Item: sampleVehicle });
      locationMock.on(SearchPlaceIndexForTextCommand).resolves({
        Results: [{ Place: { Geometry: { Point: [-122.4094, 37.7849] }, Label: "123 Main St" } }],
      });
      locationMock.on(CalculateRouteCommand).resolves({
        Summary: { 
          DurationSeconds: 600, 
          Distance: 5000,
          RouteBBox: [-122.5, 37.7, -122.4, 37.8],
          DataSource: "Esri",
          DistanceUnit: "Kilometers"
        },
      });

      const event = createEvent("GET", "/vehicles/vehicle-001/eta", {
        pathParameters: { id: "vehicle-001" },
        queryStringParameters: { destination: "123 Main St, San Francisco" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.vehicleId).toBe("vehicle-001");
      expect(body.durationMinutes).toBe(10);
      // Distance is returned in meters from the API, so 5000m = 5km
      expect(body.distanceKm).toBe(5000);
      expect(body.eta).toBeDefined();
    });

    it("should return 400 when destination is missing", async () => {
      const event = createEvent("GET", "/vehicles/vehicle-001/eta", {
        pathParameters: { id: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("destination");
    });

    it("should return 400 when address cannot be geocoded", async () => {
      ddbMock.on(GetCommand).resolves({ Item: sampleVehicle });
      locationMock.on(SearchPlaceIndexForTextCommand).resolves({ Results: [] });

      const event = createEvent("GET", "/vehicles/vehicle-001/eta", {
        pathParameters: { id: "vehicle-001" },
        queryStringParameters: { destination: "invalid address" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("geocode");
    });
  });

  describe("POST /jobs", () => {
    it("should create a new job", async () => {
      ddbMock.on(GetCommand).resolves({ Item: sampleVehicle });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
      locationMock.on(SearchPlaceIndexForTextCommand).resolves({
        Results: [{ Place: { Geometry: { Point: [-122.4094, 37.7849] }, Label: "123 Main St" } }],
      });
      locationMock.on(CalculateRouteCommand).resolves({
        Summary: { 
          DurationSeconds: 600, 
          Distance: 5000,
          RouteBBox: [-122.5, 37.7, -122.4, 37.8],
          DataSource: "Esri",
          DistanceUnit: "Kilometers"
        },
      });
      locationMock.on(PutGeofenceCommand).resolves({});

      const event = createEvent("POST", "/jobs", {
        body: { address: "123 Main St, San Francisco", vehicleId: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.jobId).toBeDefined();
      expect(body.vehicleId).toBe("vehicle-001");
      expect(body.geofenceId).toContain("job-");
    });

    it("should return 400 when vehicle already has a job", async () => {
      const busyVehicle = { ...sampleVehicle, assignedJobId: "existing-job" };
      ddbMock.on(GetCommand).resolves({ Item: busyVehicle });

      const event = createEvent("POST", "/jobs", {
        body: { address: "123 Main St", vehicleId: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("already has an assigned job");
    });

    it("should return 400 when required fields are missing", async () => {
      const event = createEvent("POST", "/jobs", {
        body: { address: "123 Main St" }, // Missing vehicleId
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("required");
    });
  });

  describe("GET /jobs", () => {
    it("should return list of jobs", async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [sampleJob] });

      const event = createEvent("GET", "/jobs");
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.jobs).toHaveLength(1);
      expect(body.count).toBe(1);
    });

    it("should filter jobs by status", async () => {
      const jobs = [
        { ...sampleJob, status: "en-route" },
        { ...sampleJob, jobId: "job-456", status: "completed" },
      ];
      ddbMock.on(ScanCommand).resolves({ Items: jobs });

      const event = createEvent("GET", "/jobs", {
        queryStringParameters: { status: "en-route" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.jobs).toHaveLength(1);
      expect(body.jobs[0].status).toBe("en-route");
    });
  });

  describe("PUT /jobs/{id}", () => {
    it("should update job status", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [sampleJob] });
      ddbMock.on(UpdateCommand).resolves({});

      const event = createEvent("PUT", "/jobs/job-123", {
        pathParameters: { id: "job-123" },
        body: { status: "completed", vehicleId: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
    });

    it("should return 404 for non-existent job", async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const event = createEvent("PUT", "/jobs/unknown", {
        pathParameters: { id: "unknown" },
        body: { status: "completed", vehicleId: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
    });

    it("should return 400 when vehicleId is missing", async () => {
      const event = createEvent("PUT", "/jobs/job-123", {
        pathParameters: { id: "job-123" },
        body: { status: "completed" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("vehicleId");
    });
  });

  describe("error handling", () => {
    it("should return 404 for unknown routes", async () => {
      const event = createEvent("GET", "/unknown");
      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body);
      expect(body.error).toBe("Not Found");
    });

    it("should return 500 on internal errors", async () => {
      ddbMock.on(ScanCommand).rejects(new Error("DynamoDB error"));

      const event = createEvent("GET", "/vehicles");
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.error).toBe("Internal Server Error");
    });
  });

  // Task 6.9: Unit tests for vehicle API enhancements
  describe("POST /jobs - Vehicle Availability Check (Task 6.3)", () => {
    it("should create job when vehicle is available", async () => {
      const availableVehicle = { ...sampleVehicle, status: "available" };
      ddbMock.on(GetCommand).resolves({ Item: availableVehicle });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
      locationMock.on(SearchPlaceIndexForTextCommand).resolves({
        Results: [{ Place: { Geometry: { Point: [-122.4094, 37.7849] }, Label: "123 Main St" } }],
      });
      locationMock.on(CalculateRouteCommand).resolves({
        Summary: { 
          DurationSeconds: 600, 
          Distance: 5000,
          RouteBBox: [-122.5, 37.7, -122.4, 37.8],
          DataSource: "Esri",
          DistanceUnit: "Kilometers"
        },
      });
      locationMock.on(PutGeofenceCommand).resolves({});

      const event = createEvent("POST", "/jobs", {
        body: { address: "123 Main St, San Francisco", vehicleId: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.jobId).toBeDefined();
      expect(body.vehicleId).toBe("vehicle-001");
    });

    it("should reject job assignment when vehicle status is en-route", async () => {
      const enRouteVehicle = { ...sampleVehicle, status: "en-route" };
      ddbMock.on(GetCommand).resolves({ Item: enRouteVehicle });

      const event = createEvent("POST", "/jobs", {
        body: { address: "123 Main St", vehicleId: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("not available");
      expect(body.message).toContain("en-route");
    });

    it("should reject job assignment when vehicle status is returning", async () => {
      const returningVehicle = { ...sampleVehicle, status: "returning" };
      ddbMock.on(GetCommand).resolves({ Item: returningVehicle });

      const event = createEvent("POST", "/jobs", {
        body: { address: "123 Main St", vehicleId: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("not available");
      expect(body.message).toContain("returning");
    });

    it("should reject job assignment when vehicle status is offline", async () => {
      const offlineVehicle = { ...sampleVehicle, status: "offline" };
      ddbMock.on(GetCommand).resolves({ Item: offlineVehicle });

      const event = createEvent("POST", "/jobs", {
        body: { address: "123 Main St", vehicleId: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("not available");
    });
  });

  describe("POST /jobs - Coordinate Validation (Task 6.5)", () => {
    it("should create job with valid coordinates from geocoding", async () => {
      const availableVehicle = { ...sampleVehicle, status: "available" };
      ddbMock.on(GetCommand).resolves({ Item: availableVehicle });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
      // Valid coordinates: lat 37.7849 (within -90 to 90), lng -122.4094 (within -180 to 180)
      locationMock.on(SearchPlaceIndexForTextCommand).resolves({
        Results: [{ Place: { Geometry: { Point: [-122.4094, 37.7849] }, Label: "Valid Address" } }],
      });
      locationMock.on(CalculateRouteCommand).resolves({
        Summary: { DurationSeconds: 600, Distance: 5000, RouteBBox: [], DataSource: "Esri", DistanceUnit: "Kilometers" },
      });
      locationMock.on(PutGeofenceCommand).resolves({});

      const event = createEvent("POST", "/jobs", {
        body: { address: "Valid Address", vehicleId: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.coordinates.lat).toBe(37.7849);
      expect(body.coordinates.lng).toBe(-122.4094);
    });

    it("should create geofence with job-{jobId} naming pattern", async () => {
      const availableVehicle = { ...sampleVehicle, status: "available" };
      ddbMock.on(GetCommand).resolves({ Item: availableVehicle });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
      locationMock.on(SearchPlaceIndexForTextCommand).resolves({
        Results: [{ Place: { Geometry: { Point: [-122.4094, 37.7849] }, Label: "Test Address" } }],
      });
      locationMock.on(CalculateRouteCommand).resolves({
        Summary: { DurationSeconds: 600, Distance: 5000, RouteBBox: [], DataSource: "Esri", DistanceUnit: "Kilometers" },
      });
      locationMock.on(PutGeofenceCommand).resolves({});

      const event = createEvent("POST", "/jobs", {
        body: { address: "Test Address", vehicleId: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.geofenceId).toMatch(/^job-[a-f0-9-]+$/);
    });
  });

  describe("POST /jobs - Geofence Creation Failure", () => {
    it("should return 500 when geofence creation fails", async () => {
      const availableVehicle = { ...sampleVehicle, status: "available" };
      ddbMock.on(GetCommand).resolves({ Item: availableVehicle });
      locationMock.on(SearchPlaceIndexForTextCommand).resolves({
        Results: [{ Place: { Geometry: { Point: [-122.4094, 37.7849] }, Label: "Test Address" } }],
      });
      locationMock.on(CalculateRouteCommand).resolves({
        Summary: { DurationSeconds: 600, Distance: 5000, RouteBBox: [], DataSource: "Esri", DistanceUnit: "Kilometers" },
      });
      locationMock.on(PutGeofenceCommand).rejects(new Error("Geofence creation failed"));

      const event = createEvent("POST", "/jobs", {
        body: { address: "Test Address", vehicleId: "vehicle-001" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body);
      expect(body.error).toBe("Internal Server Error");
    });
  });

  describe("POST /subscriptions/email (Task 6.1)", () => {
    it("should subscribe email successfully", async () => {
      // Reset mocks and set up specific mock for this test
      ddbMock.reset();
      ddbMock.on(PutCommand).resolves({});

      const event = createEvent("POST", "/subscriptions/email", {
        body: { email: "test@example.com" },
      });
      // Add mock authorizer claims for tenantId extraction
      (event.requestContext as any).authorizer = { claims: { "custom:tenantId": "tenant-123" } };
      const result = await handler(event);

      expect(result.statusCode).toBe(201);
      const body = JSON.parse(result.body);
      expect(body.message).toBe("Subscribed successfully");
      expect(body.email).toBe("test@example.com");
      expect(body.subscribedAt).toBeDefined();
    });

    it("should return 400 when email is missing", async () => {
      const event = createEvent("POST", "/subscriptions/email", {
        body: {},
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("email is required");
    });

    it("should return 400 for invalid email format", async () => {
      const event = createEvent("POST", "/subscriptions/email", {
        body: { email: "invalid-email" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("Invalid email format");
    });

    it("should return 400 for email without domain", async () => {
      const event = createEvent("POST", "/subscriptions/email", {
        body: { email: "test@" },
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("Invalid email format");
    });
  });

  describe("DELETE /subscriptions/email (Task 6.1)", () => {
    it("should unsubscribe email successfully", async () => {
      // Reset mocks and set up specific mock for this test
      ddbMock.reset();
      ddbMock.on(DeleteCommand).resolves({});

      const event = createEvent("DELETE", "/subscriptions/email", {
        body: { email: "test@example.com" },
      });
      // Add mock authorizer claims for tenantId extraction
      (event.requestContext as any).authorizer = { claims: { "custom:tenantId": "tenant-123" } };
      const result = await handler(event);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.message).toBe("Unsubscribed successfully");
      expect(body.email).toBe("test@example.com");
    });

    it("should return 400 when email is missing for unsubscribe", async () => {
      const event = createEvent("DELETE", "/subscriptions/email", {
        body: {},
      });
      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body);
      expect(body.message).toContain("email is required");
    });
  });
});
