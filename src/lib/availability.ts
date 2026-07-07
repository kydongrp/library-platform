import { DIGITAL_TYPES } from "@/lib/constants";

type ResourceLike = {
  type: string;
  digital: boolean;
  provider?: string | null;
  copies: { status: string }[];
};

export function isDigital(resource: { type: string; digital: boolean }): boolean {
  return resource.digital || DIGITAL_TYPES.has(resource.type);
}

/** True for externally-subscribed content (e.g. IEEE Xplore) accessed via the provider. */
export function isExternal(resource: { provider?: string | null }): boolean {
  return !!resource.provider;
}

/** Number of copies currently available for checkout. */
export function availableCopies(resource: ResourceLike): number {
  return resource.copies.filter((c) => c.status === "AVAILABLE").length;
}

/**
 * Availability summary used by both portals.
 * - External provider resources are accessed via the provider (no loan).
 * - Other digital resources grant instant access (a digital loan).
 * - Physical resources depend on available copies.
 */
export function availability(resource: ResourceLike): {
  state: "external" | "digital" | "available" | "unavailable";
  available: number;
  total: number;
  label: string;
} {
  if (isExternal(resource)) {
    return {
      state: "external",
      available: Infinity,
      total: Infinity,
      label: `Via ${resource.provider}`,
    };
  }
  if (isDigital(resource)) {
    return { state: "digital", available: Infinity, total: Infinity, label: "Instant access" };
  }
  const total = resource.copies.length;
  const available = availableCopies(resource);
  if (available > 0) {
    return {
      state: "available",
      available,
      total,
      label: `${available} of ${total} available`,
    };
  }
  return { state: "unavailable", available: 0, total, label: "All copies out" };
}
