#!/bin/bash
# Fleet Tracking Platform - Pre-Cleanup Script
# Removes resources that block CDK stack deletion
# Run BEFORE: npx cdk destroy --all --force
# Usage: ./scripts/pre-cleanup.sh

set -e

# Load shared configuration (AWS_REGION, FLEET_VEHICLES, etc.)
source "$(dirname "$0")/lib/config.sh"

echo "Fleet Tracking Platform - Pre-Cleanup"
echo "======================================"
echo "Region: $AWS_REGION"
echo ""
echo "This script detaches resources that block CDK stack deletion."
echo ""

# 1. IoT Certificates - detach from Things and Policies (but don't delete - CDK manages them)
echo "=== Detaching IoT Certificates ==="
for thing in "${FLEET_VEHICLES[@]}"; do
  cert_arns=$(aws iot list-thing-principals --thing-name "$thing" --region "$AWS_REGION" --query 'principals[*]' --output text 2>/dev/null || true)
  if [ -n "$cert_arns" ]; then
    for cert_arn in $cert_arns; do
      cert_id=$(echo "$cert_arn" | cut -d'/' -f2)
      echo "  Detaching certificate $cert_id from $thing..."
      aws iot detach-thing-principal --thing-name "$thing" --principal "$cert_arn" --region "$AWS_REGION" 2>/dev/null || true
      aws iot detach-policy --policy-name "$FLEET_VEHICLE_POLICY" --target "$cert_arn" --region "$AWS_REGION" 2>/dev/null || true
      # Deactivate certificate so it can be deleted by CDK
      aws iot update-certificate --certificate-id "$cert_id" --new-status INACTIVE --region "$AWS_REGION" 2>/dev/null || true
    done
  fi
done

# 2. Remove Things from Thing Group (allows Thing Group deletion)
echo "=== Removing Things from Thing Group ==="
for thing in "${FLEET_VEHICLES[@]}"; do
  aws iot remove-thing-from-thing-group --thing-name "$thing" --thing-group-name "$FLEET_THING_GROUP" --region "$AWS_REGION" 2>/dev/null && echo "  Removed $thing from $FLEET_THING_GROUP" || true
done

# 3. Delete geofences from collection (allows Geofence Collection deletion)
echo "=== Cleaning Geofences ==="
# List and delete all geofences in the geofence collection
geofence_ids=$(aws location list-geofences --collection-name "$FLEET_GEOFENCE_COLLECTION" --region "$AWS_REGION" --query "Entries[*].GeofenceId" --output text 2>/dev/null || true)
if [ -n "$geofence_ids" ]; then
  for gf_id in $geofence_ids; do
    echo "  Deleting geofence $gf_id..."
  done
  # Batch delete (up to 10 at a time)
  aws location batch-delete-geofence --collection-name "$FLEET_GEOFENCE_COLLECTION" --geofence-ids $geofence_ids --region "$AWS_REGION" 2>/dev/null || true
fi

# 4. Disconnect tracker from geofence collection (allows Tracker deletion)
echo "=== Disconnecting Tracker Consumer ==="
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws location disassociate-tracker-consumer --tracker-name "$FLEET_TRACKER" --consumer-arn "arn:aws:geo:$AWS_REGION:$ACCOUNT_ID:geofence-collection/$FLEET_GEOFENCE_COLLECTION" --region "$AWS_REGION" 2>/dev/null && echo "  Disconnected tracker from geofence collection" || true

echo ""
echo "======================================"
echo "Pre-cleanup complete!"
echo ""
echo "Now run: cd infra && npx cdk destroy --all --force"
echo "Then run: ./scripts/post-cleanup.sh"
