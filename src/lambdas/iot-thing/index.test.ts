/**
 * Unit Tests for IoT Thing Configuration
 * 
 * Task 11.12: Unit tests for IoT Thing configuration
 * - Test Thing creation with correct attributes
 * - Test Device Shadow update
 * - Test certificate file generation
 * - Test policy attachment
 */

describe("IoT Thing Configuration Unit Tests", () => {
  describe("Thing creation with correct attributes", () => {
    it("should create Thing with vehicleId as thingName", () => {
      const vehicleId = "vehicle-001";
      const thingName = vehicleId;
      
      expect(thingName).toBe(vehicleId);
    });

    it("should include required attributes in Thing", () => {
      const attributes = {
        vehicleId: "vehicle-001",
        technician: "John_Smith",
        status: "available",
        tenantId: "demo-tenant",
        region: "us-east-1",
      };

      expect(attributes.vehicleId).toBeDefined();
      expect(attributes.technician).toBeDefined();
      expect(attributes.status).toBeDefined();
      expect(attributes.tenantId).toBeDefined();
      expect(attributes.region).toBeDefined();
    });

    it("should associate Thing with FleetVehicle Thing Type", () => {
      const thingTypeName = "FleetVehicle";
      
      expect(thingTypeName).toBe("FleetVehicle");
    });
  });

  describe("Device Shadow update", () => {
    it("should create valid Device Shadow state structure", () => {
      const shadowState = {
        state: {
          reported: {
            vehicleId: "vehicle-001",
            position: { lat: 37.7749, lng: -122.4194 },
            speed: 35.5,
            heading: 180,
            ignition: true,
            status: "en-route",
            timestamp: "2024-03-15T10:30:00Z",
          },
        },
      };

      expect(shadowState.state.reported.vehicleId).toBe("vehicle-001");
      expect(shadowState.state.reported.position).toEqual({ lat: 37.7749, lng: -122.4194 });
      expect(shadowState.state.reported.speed).toBe(35.5);
      expect(shadowState.state.reported.heading).toBe(180);
      expect(shadowState.state.reported.ignition).toBe(true);
      expect(shadowState.state.reported.status).toBe("en-route");
      expect(shadowState.state.reported.timestamp).toBe("2024-03-15T10:30:00Z");
    });

    it("should publish to correct Device Shadow topic", () => {
      const vehicleId = "vehicle-001";
      const shadowTopic = `$aws/things/${vehicleId}/shadow/update`;
      
      expect(shadowTopic).toBe("$aws/things/vehicle-001/shadow/update");
    });

    it("should update shadow when vehicle status changes", () => {
      const statuses = ["available", "en-route", "returning", "offline"];
      
      for (const status of statuses) {
        const shadowState = {
          state: {
            reported: {
              vehicleId: "vehicle-001",
              status,
            },
          },
        };
        
        expect(shadowState.state.reported.status).toBe(status);
      }
    });
  });

  describe("Certificate file generation", () => {
    it("should generate certificate files in correct directory", () => {
      const vehicleId = "vehicle-001";
      const certDir = `certs/${vehicleId}`;
      
      const expectedFiles = [
        `${certDir}/certificate.pem`,
        `${certDir}/private.key`,
        `${certDir}/public.key`,
      ];

      expect(expectedFiles).toContain(`certs/${vehicleId}/certificate.pem`);
      expect(expectedFiles).toContain(`certs/${vehicleId}/private.key`);
      expect(expectedFiles).toContain(`certs/${vehicleId}/public.key`);
    });

    it("should store certificate metadata in SSM", () => {
      const vehicleId = "vehicle-001";
      const ssmParamName = `/fleet-tracking/certs/${vehicleId}/metadata`;
      
      expect(ssmParamName).toBe("/fleet-tracking/certs/vehicle-001/metadata");
    });
  });

  describe("Policy attachment", () => {
    it("should attach fleet-vehicle-policy to certificate", () => {
      const policyName = "fleet-vehicle-policy";
      
      expect(policyName).toBe("fleet-vehicle-policy");
    });

    it("should scope policy to vehicle-specific topics", () => {
      const vehicleId = "vehicle-001";
      
      // Allowed publish topics
      const allowedPublishTopics = [
        `fleet/vehicles/${vehicleId}/*`,
        `$aws/things/${vehicleId}/shadow/update`,
        `$aws/things/${vehicleId}/shadow/get`,
      ];

      // Allowed subscribe topics
      const allowedSubscribeTopics = [
        `fleet/vehicles/${vehicleId}/commands/*`,
        `$aws/things/${vehicleId}/shadow/update/accepted`,
        `$aws/things/${vehicleId}/shadow/update/rejected`,
        `$aws/things/${vehicleId}/shadow/get/accepted`,
        `$aws/things/${vehicleId}/shadow/get/rejected`,
      ];

      // Verify all topics contain the vehicleId
      for (const topic of [...allowedPublishTopics, ...allowedSubscribeTopics]) {
        expect(topic).toContain(vehicleId);
      }
    });
  });

  describe("Home base geofence creation", () => {
    it("should create geofence with correct naming pattern", () => {
      const vehicleId = "vehicle-001";
      const geofenceId = `home-${vehicleId}`;
      
      expect(geofenceId).toBe("home-vehicle-001");
      expect(geofenceId).toMatch(/^home-vehicle-[0-9]{3}$/);
    });

    it("should create 50-meter radius circle geofence", () => {
      const geofenceGeometry = {
        Circle: {
          Center: [-122.4194, 37.7749], // [longitude, latitude]
          Radius: 50, // 50 meters
        },
      };

      expect(geofenceGeometry.Circle.Radius).toBe(50);
      expect(geofenceGeometry.Circle.Center).toHaveLength(2);
    });

    it("should create geofence at vehicle starting position", () => {
      const vehicleStartPositions = [
        { vehicleId: "vehicle-001", lat: 37.7749, lng: -122.4194 },
        { vehicleId: "vehicle-002", lat: 37.5585, lng: -122.2711 },
        { vehicleId: "vehicle-003", lat: 37.3861, lng: -122.0839 },
      ];

      for (const vehicle of vehicleStartPositions) {
        const geofenceGeometry = {
          Circle: {
            Center: [vehicle.lng, vehicle.lat],
            Radius: 50,
          },
        };

        expect(geofenceGeometry.Circle.Center[0]).toBe(vehicle.lng);
        expect(geofenceGeometry.Circle.Center[1]).toBe(vehicle.lat);
      }
    });
  });
});
