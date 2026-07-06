export interface VehicleConfig {
  vehicleId: string;
  technician: string;
  make: string;
  model: string;
  baseSpeed: number; // mph
  startPosition: {
    lat: number;
    lng: number;
    name: string;
  };
}

// Demo vehicles - parked at various locations in San Francisco Bay Area
export const demoVehicles: VehicleConfig[] = [
  {
    vehicleId: "vehicle-001",
    technician: "Alice Johnson",
    make: "Ford",
    model: "Transit",
    baseSpeed: 35,
    startPosition: { lat: 37.7749, lng: -122.4194, name: "Union Square, SF" },
  },
  {
    vehicleId: "vehicle-002",
    technician: "Bob Smith",
    make: "Chevrolet",
    model: "Express",
    baseSpeed: 30,
    startPosition: { lat: 37.5585, lng: -122.2711, name: "San Mateo" },
  },
  {
    vehicleId: "vehicle-003",
    technician: "Carol Davis",
    make: "RAM",
    model: "ProMaster",
    baseSpeed: 40,
    startPosition: { lat: 37.3861, lng: -122.0839, name: "Mountain View" },
  },
  {
    vehicleId: "vehicle-004",
    technician: "David Wilson",
    make: "Mercedes",
    model: "Sprinter",
    baseSpeed: 25,
    startPosition: { lat: 37.8024, lng: -122.4058, name: "North Beach, SF" },
  },
  {
    vehicleId: "vehicle-005",
    technician: "Eva Martinez",
    make: "Ford",
    model: "E-Series",
    baseSpeed: 30,
    startPosition: { lat: 37.4419, lng: -122.1430, name: "Palo Alto" },
  },
];
