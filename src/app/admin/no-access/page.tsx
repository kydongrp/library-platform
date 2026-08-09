import Link from "next/link";
import { getCurrentAdmin } from "@/lib/admin-session";

export const dynamic = "force-dynamic";

export default async function NoAccessPage() {
  const admin = await getCurrentAdmin();
  return (
    <div className="mx-auto max-w-lg px-5 py-20 text-center">
      <p className="text-5xl">🔒</p>
      <h1 className="mt-4 font-display text-2xl font-semibold">No access to this module</h1>
      <p className="mt-2 text-muted-foreground">
        {admin
          ? `Your group (${admin.groupName}) doesn't have view rights for this area. An administrator can grant access in Admin Settings.`
          : "You're not signed in."}
      </p>
      <Link href="/admin" className="mt-6 inline-block text-primary hover:underline">
        ← Back to dashboard
      </Link>
    </div>
  );
}
