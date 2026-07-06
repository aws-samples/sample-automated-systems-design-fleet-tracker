#!/bin/bash
# Shared configuration for fleet tracking scripts
# Source this file from other scripts: source "$(dirname "$0")/lib/config.sh"

# AWS region — override with AWS_REGION environment variable or AWS CLI config
export AWS_REGION="${AWS_REGION:-us-east-1}"

# Demo vehicle list — used by provisioning and cleanup scripts
export FLEET_VEHICLES=("vehicle-001" "vehicle-002" "vehicle-003" "vehicle-004" "vehicle-005")

# IoT resource names (must match CDK stack definitions)
export FLEET_VEHICLE_POLICY="fleet-vehicle-policy"
export FLEET_THING_GROUP="fleet-vehicles"

# Location Service resource names (must match CDK stack definitions)
export FLEET_TRACKER="fleet-tracker"
export FLEET_GEOFENCE_COLLECTION="job-sites"
