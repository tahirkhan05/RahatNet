/**
 * @module resource
 *
 * Types for physical relief resources tracked in RahatNet.
 *
 * Resources are the physical assets deployed to address needs: boats to
 * rescue people, food packets to feed them, medicine kits to treat them.
 *
 * Tracking resources prevents the "two boats to the same house" problem —
 * the war room can see exactly what is deployed, where, and whether it has
 * been returned.
 *
 * Lifecycle:
 *   Resource registered (status: AVAILABLE)
 *       ↓  Coordinator allocates to a need
 *   ResourceAllocation created → Resource.deployed count incremented
 *       ↓  Volunteer confirms resource used / returned
 *   ResourceAllocation (status: RETURNED | CONSUMED)
 *       ↓  All units deployed
 *   Resource (status: DEPLETED or AVAILABLE again)
 */

import type { Timestamp } from 'firebase/firestore';
import type { GeoPoint } from './need';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/**
 * Category of physical relief resource.
 * Drives the icon displayed in the war-room resource tracker.
 */
export enum ResourceType {
  /**
   * Motor boat, country boat, or inflatable rescue raft.
   * Used for RESCUE needs in flooded areas.
   */
  BOAT = 'BOAT',
  /**
   * Pre-packaged food parcel (typically 1-day supply for one person).
   * Used for FOOD needs.
   */
  FOOD_PACKET = 'FOOD_PACKET',
  /**
   * First-aid kit, medicine parcel, or medical supply crate.
   * Used for MEDICINE needs.
   */
  MEDICINE_KIT = 'MEDICINE_KIT',
  /**
   * Tarpaulin, tent, blanket, or temporary shelter material.
   * Used for SHELTER needs.
   */
  SHELTER_KIT = 'SHELTER_KIT',
  /**
   * 4WD vehicle, truck, or ambulance.
   * Used to transport volunteers and supplies to inaccessible areas.
   */
  VEHICLE = 'VEHICLE',
  /**
   * Satellite phone, walkie-talkie, or portable radio.
   * Used when mobile networks are down in disaster zones.
   */
  COMMUNICATION_DEVICE = 'COMMUNICATION_DEVICE',
}

/**
 * Current availability status of a resource unit.
 */
export enum ResourceStatus {
  /** Available for deployment — not currently allocated. */
  AVAILABLE = 'AVAILABLE',
  /** Allocated to a specific need and with a volunteer. */
  DEPLOYED = 'DEPLOYED',
  /**
   * Temporarily out of service (e.g. boat engine repair, vehicle maintenance).
   * Will return to AVAILABLE when repaired.
   */
  MAINTENANCE = 'MAINTENANCE',
  /**
   * All units consumed or lost.  Quantity > 0 but available === 0.
   * The resource should be replenished or removed from tracking.
   */
  DEPLETED = 'DEPLETED',
}

/**
 * Physical condition of a resource unit.
 * Coordinators update this when resources are returned after deployment.
 */
export enum ResourceCondition {
  /** Resource is fully functional and ready for immediate deployment. */
  GOOD = 'GOOD',
  /** Resource has minor damage but is still usable. */
  FAIR = 'FAIR',
  /**
   * Resource is significantly damaged and should not be deployed until repaired.
   * Setting this triggers a maintenance flag on the resource.
   */
  POOR = 'POOR',
  /** Resource is beyond repair and should be written off. */
  DAMAGED_BEYOND_REPAIR = 'DAMAGED_BEYOND_REPAIR',
}

/**
 * Status of a single ResourceAllocation record.
 */
export enum ResourceAllocationStatus {
  /** Resource allocated; not yet confirmed as received by volunteer. */
  ALLOCATED = 'ALLOCATED',
  /**
   * Volunteer confirmed receipt and is carrying the resource to the need site.
   */
  IN_TRANSIT = 'IN_TRANSIT',
  /**
   * Resource delivered to the need site and is being used.
   */
  IN_USE = 'IN_USE',
  /**
   * Consumable resource (food, medicine) was fully used at the need site.
   * Quantity is permanently reduced.
   */
  CONSUMED = 'CONSUMED',
  /**
   * Durable resource (boat, vehicle) returned to the depot after use.
   * Quantity is freed up for reallocation.
   */
  RETURNED = 'RETURNED',
  /**
   * Resource was lost, damaged beyond use, or stolen during deployment.
   * Coordinator documents the loss.
   */
  LOST = 'LOST',
}

// ---------------------------------------------------------------------------
// Core domain interfaces
// ---------------------------------------------------------------------------

/**
 * A tracked physical resource available for deployment in a disaster.
 *
 * Resources are registered by coordinators when supplies arrive at the
 * collection point.  They are then allocated to specific needs as
 * volunteers are dispatched.
 *
 * Firestore path: /resources/{resourceId}
 */
export interface Resource {
  /** Firestore document ID. */
  readonly id: string;
  /** Category of this resource. */
  readonly type: ResourceType;
  /**
   * Human-readable description.
   * e.g. "15-foot motorised country boat, 8-person capacity"
   */
  readonly description: string;
  /**
   * Total units registered for this resource record.
   * e.g. 10 food packets, 1 boat, 500 medicine kits.
   */
  readonly quantity: number;
  /**
   * Units currently deployed (out with volunteers, en-route or in-use).
   * available = quantity − deployed.
   */
  readonly deployed: number;
  /**
   * Current availability status derived from quantity, deployed, and condition.
   */
  readonly status: ResourceStatus;
  /** Physical condition of the resource. */
  readonly condition: ResourceCondition;
  /**
   * Current GPS location of the resource (depot, staging area, or en-route).
   * Updated by the volunteer's location tracking when the resource is deployed.
   */
  readonly location: GeoPoint;
  /**
   * Human-readable name of the current location.
   * e.g. "Aluva Govt. School Relief Camp", "North Ernakulam Staging Area".
   */
  readonly locationName: string;
  /**
   * Firebase Auth UID of the coordinator or volunteer currently responsible
   * for this resource.  Null when unassigned (at depot, managed by any coordinator).
   */
  readonly assignedTo: string | null;
  /** ID of the DisasterEvent this resource is allocated to. */
  readonly disasterEventId: string;
  /** Name or contact of the donor / supplier who provided this resource. */
  readonly donorName: string | null;
  /** Firestore server timestamp of initial registration. */
  readonly createdAt: Timestamp;
  /** Firestore server timestamp of last update to any field. */
  readonly updatedAt: Timestamp;
  /**
   * True when this document was inserted by the demo seed script.
   */
  readonly isDemoData?: boolean;
}

/**
 * A record of a specific quantity of a resource being allocated to a need.
 *
 * Multiple allocations may exist for a single resource (e.g. 100 food
 * packets allocated in batches of 10 to different needs).
 *
 * Firestore path: /resources/{resourceId}/allocations/{allocationId}
 */
export interface ResourceAllocation {
  /** Firestore document ID. */
  readonly id: string;
  /** ID of the parent Resource document. */
  readonly resourceId: string;
  /**
   * ID of the CanonicalNeed this allocation is addressing.
   * Null for allocations to a staging area (not yet assigned to a specific need).
   */
  readonly needId: string | null;
  /**
   * ID of the Assignment this allocation is linked to.
   * Null for coordinator-initiated bulk allocations.
   */
  readonly assignmentId: string | null;
  /** Number of resource units allocated. Min 1. */
  readonly quantity: number;
  /** Current status of this allocation. */
  readonly status: ResourceAllocationStatus;
  /**
   * Firebase Auth UID of the coordinator who authorised the allocation.
   */
  readonly allocatedBy: string;
  /**
   * Firebase Auth UID of the volunteer carrying or using the resource.
   * Null for allocations that have not yet been claimed by a volunteer.
   */
  readonly carriedBy: string | null;
  /** GPS coordinates of the resource at the time of allocation. */
  readonly pickupLocation: GeoPoint;
  /** Human-readable pickup location name. */
  readonly pickupLocationName: string;
  /** Firestore server timestamp when the allocation was created. */
  readonly allocatedAt: Timestamp;
  /**
   * Firestore server timestamp when the resource was returned to depot.
   * Null for consumables or resources not yet returned.
   */
  readonly returnedAt: Timestamp | null;
  /**
   * Condition of the resource when returned.
   * Null until returnedAt is populated.
   */
  readonly returnedCondition: ResourceCondition | null;
  /** Coordinator notes about this allocation or its outcome. */
  readonly notes: string | null;
}

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/**
 * Derived read-only view combining a Resource with its computed availability.
 * Used in the war-room resource tracker UI.
 */
export interface ResourceSummary {
  readonly resource: Resource;
  /** Units not currently deployed: resource.quantity − resource.deployed. */
  readonly available: number;
  /** Percentage deployed: (deployed / quantity) × 100. */
  readonly deploymentRate: number;
  /** True when available < 10% of quantity. */
  readonly isLow: boolean;
  /** True when available === 0. */
  readonly isDepleted: boolean;
}

/**
 * Fields a coordinator may update on an existing resource.
 */
export type ResourceUpdatePayload = Partial<
  Pick<
    Resource,
    | 'description'
    | 'quantity'
    | 'deployed'
    | 'status'
    | 'condition'
    | 'location'
    | 'locationName'
    | 'assignedTo'
  >
>;
