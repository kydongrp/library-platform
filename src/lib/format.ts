// Presentation helpers shared across server and client components.

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

const DAY = 24 * 60 * 60 * 1000;

/** Whole days until `due` from now. Negative when overdue. */
export function daysUntil(due: Date | string): number {
  const d = typeof due === "string" ? new Date(due) : due;
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfDue = new Date(d);
  startOfDue.setHours(0, 0, 0, 0);
  return Math.round((startOfDue.getTime() - startOfToday.getTime()) / DAY);
}

export function isOverdue(due: Date | string, returnedAt?: Date | null): boolean {
  if (returnedAt) return false;
  return daysUntil(due) < 0;
}

/** "Due in 3 days", "Due today", "Overdue by 2 days". */
export function dueLabel(due: Date | string, returnedAt?: Date | null): string {
  if (returnedAt) return `Returned ${formatDate(returnedAt)}`;
  const n = daysUntil(due);
  if (n < 0) return `Overdue by ${Math.abs(n)} day${Math.abs(n) === 1 ? "" : "s"}`;
  if (n === 0) return "Due today";
  return `Due in ${n} day${n === 1 ? "" : "s"}`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}
