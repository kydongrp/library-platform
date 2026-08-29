"use client";

import { useState } from "react";
import { StatefulForm, SubmitButton } from "@/components/forms";
import { MEMBER_LANGUAGES } from "@/lib/constants";
import type { ActionState } from "@/lib/types";

type Defaults = {
  id?: string;
  memberNo?: string | null;
  associateId?: string | null;
  associateId2?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string;
  title?: string | null;
  position?: string | null;
  email?: string;
  memberType?: string;
  status?: string;
  phone?: string | null;
  language?: string;
  location?: string | null;
  department?: string | null;
  membershipStartAt?: string | null;
  membershipExpiryAt?: string | null;
  remark?: string | null;
  photoUrl?: string | null;
  receiveEmailNotices?: boolean;
  receiveSms?: boolean;
  hasPassword?: boolean;
  maxLoans?: number;
  contacts?: { kind: string; label: string | null; value: string }[];
  addresses?: {
    label: string | null;
    line1: string | null;
    line2: string | null;
    line3: string | null;
    postal: string | null;
    country: string | null;
  }[];
};

export type StatusOption = { name: string; suspends: boolean; isDefault: boolean };

const labelCls = "block text-sm font-medium text-foreground mb-1.5";
const inputCls =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

export function MemberForm({
  action,
  statuses,
  memberTypes,
  locations = [],
  departments = [],
  defaults = {},
  submitLabel = "Save",
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  statuses: StatusOption[];
  /**
   * Member types to offer. Passed in rather than imported: the list is managed
   * in the database, and this is a client component. Includes any type a member
   * is already on, so editing that member does not silently reassign them.
   */
  memberTypes: { name: string; label: string }[];
  /** Managed registration lists; empty = the field falls back to free text. */
  locations?: string[];
  departments?: string[];
  defaults?: Defaults;
  submitLabel?: string;
}) {
  const [memberType, setMemberType] = useState(
    defaults.memberType ?? memberTypes[0]?.name ?? "",
  );
  const defaultStatus =
    defaults.status ?? statuses.find((s) => s.isDefault)?.name ?? statuses[0]?.name ?? "Active";

  return (
    <StatefulForm action={action} className="max-w-2xl space-y-4">
      {(state) => (
        <>
          {defaults.id && <input type="hidden" name="id" value={defaults.id} />}

          <Section title="Identity">
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className={labelCls} htmlFor="memberNo">Member ID *</label>
                <input id="memberNo" name="memberNo" required maxLength={40}
                  defaultValue={defaults.memberNo ?? ""} className={inputCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="associateId">Associate ID</label>
                <input id="associateId" name="associateId" maxLength={40}
                  defaultValue={defaults.associateId ?? ""} className={inputCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="associateId2">Associate ID 2</label>
                <input id="associateId2" name="associateId2" maxLength={40}
                  defaultValue={defaults.associateId2 ?? ""} className={inputCls} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="lastName">Last name *</label>
                <input id="lastName" name="lastName" required maxLength={100}
                  defaultValue={defaults.lastName ?? ""} className={inputCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="firstName">First name</label>
                <input id="firstName" name="firstName" maxLength={100}
                  defaultValue={defaults.firstName ?? ""} className={inputCls} />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className={labelCls} htmlFor="title">Title</label>
                <input id="title" name="title" maxLength={60} placeholder="e.g. Dr"
                  defaultValue={defaults.title ?? ""} className={inputCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="position">Position</label>
                <input id="position" name="position" maxLength={120}
                  defaultValue={defaults.position ?? ""} className={inputCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="language">Preferred language</label>
                <select id="language" name="language" defaultValue={defaults.language ?? "English"} className={inputCls}>
                  {MEMBER_LANGUAGES.map((l) => (
                    <option key={l} value={l}>{l}</option>
                  ))}
                </select>
              </div>
            </div>
          </Section>

          <Section title="Contact">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="email">Email *</label>
                <input id="email" name="email" type="email" required defaultValue={defaults.email ?? ""} className={inputCls} />
                <p className="mt-1 text-xs text-muted-foreground">
                  The primary address. Notices go here; extras below are for reference.
                </p>
              </div>
              <div>
                <label className={labelCls} htmlFor="phone">Phone</label>
                <input id="phone" name="phone" defaultValue={defaults.phone ?? ""}
                  placeholder="+65 9123 4567" className={inputCls} />
              </div>
            </div>

            <ContactRows initial={defaults.contacts ?? []} />
            <AddressRows initial={defaults.addresses ?? []} />

            <div className="flex flex-wrap gap-5 pt-1">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="receiveEmailNotices"
                  defaultChecked={defaults.receiveEmailNotices ?? false}
                  className="h-4 w-4 rounded border-border accent-primary" />
                Receive email notices
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="receiveSms"
                  defaultChecked={defaults.receiveSms ?? false}
                  className="h-4 w-4 rounded border-border accent-primary" />
                Receive SMS
              </label>
            </div>
          </Section>

          <Section title="Membership">
          <div className="grid gap-4 sm:grid-cols-2">
            <RegListField
              id="location"
              label="Location (campus / site)"
              options={locations}
              current={defaults.location ?? ""}
              placeholder="e.g. Depot Road Campus"
            />
            <RegListField
              id="department"
              label="Department"
              options={departments}
              current={defaults.department ?? ""}
              placeholder="e.g. Engineering Faculty"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <label className={labelCls} htmlFor="memberType">Member type *</label>
              <select id="memberType" name="memberType" value={memberType}
                onChange={(e) => setMemberType(e.target.value)} className={inputCls}>
                {memberTypes.map((t) => (
                  <option key={t.name} value={t.name}>{t.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Loan period set by Loan Policies for this member type
              </p>
            </div>
            <div>
              <label className={labelCls} htmlFor="status">Status *</label>
              <select id="status" name="status" defaultValue={defaultStatus} className={inputCls}>
                {statuses.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.name}{s.suspends ? " (suspended)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="maxLoans">Max concurrent loans</label>
              <input id="maxLoans" name="maxLoans" type="number" min="1" max="50"
                defaultValue={defaults.maxLoans ?? ""} placeholder="Type default"
                className={inputCls} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="membershipStartAt">Membership start date</label>
              <input id="membershipStartAt" name="membershipStartAt" type="date"
                defaultValue={defaults.membershipStartAt ?? ""} className={inputCls} />
            </div>
            <div>
              <label className={labelCls} htmlFor="membershipExpiryAt">Membership expiry date</label>
              <input id="membershipExpiryAt" name="membershipExpiryAt" type="date"
                defaultValue={defaults.membershipExpiryAt ?? ""} className={inputCls} />
              <p className="mt-1 text-xs text-muted-foreground">
                Advisory. Nothing is revoked automatically on this date.
              </p>
            </div>
          </div>
          </Section>

          <Section title="Portal sign-in">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className={labelCls} htmlFor="password">
                  {defaults.hasPassword ? "Change password" : "Set password"}
                </label>
                <input id="password" name="password" type="password" autoComplete="new-password"
                  minLength={10} maxLength={200}
                  placeholder={defaults.hasPassword ? "Leave blank to keep the current one" : "At least 10 characters"}
                  className={inputCls} />
                <p className="mt-1 text-xs text-muted-foreground">
                  Stored only as a salted hash. Leaving this blank never clears an existing password.
                </p>
              </div>
              <div>
                <label className={labelCls} htmlFor="photoUrl">Photo URL</label>
                <input id="photoUrl" name="photoUrl" type="url" maxLength={500}
                  defaultValue={defaults.photoUrl ?? ""}
                  placeholder="https://…" className={inputCls} />
                <p className="mt-1 text-xs text-muted-foreground">
                  A link only. There is no file store wired up for uploads.
                </p>
              </div>
            </div>

            <div>
              <label className={labelCls} htmlFor="remark">Remark</label>
              <textarea id="remark" name="remark" rows={3} maxLength={2000}
                defaultValue={defaults.remark ?? ""}
                placeholder="Staff note. Not shown to the member."
                className={`${inputCls} resize-y`} />
            </div>
          </Section>

          {state.ok === false && state.message && (
            <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.message}</p>
          )}

          <div className="pt-1">
            <SubmitButton pendingLabel="Saving…">{submitLabel}</SubmitButton>
          </div>
        </>
      )}
    </StatefulForm>
  );
}

/**
 * A registration list field: a select over the managed list when one exists
 * (rows 42-43), a free-text input otherwise. A member's current value that is
 * no longer on the list stays selectable, so editing never silently drops it.
 */
function RegListField({
  id,
  label,
  options,
  current,
  placeholder,
}: {
  id: string;
  label: string;
  options: string[];
  current: string;
  placeholder: string;
}) {
  if (options.length === 0) {
    return (
      <div>
        <label className={labelCls} htmlFor={id}>{label}</label>
        <input id={id} name={id} defaultValue={current} placeholder={placeholder} className={inputCls} />
      </div>
    );
  }
  const withCurrent = current && !options.includes(current) ? [current, ...options] : options;
  return (
    <div>
      <label className={labelCls} htmlFor={id}>{label}</label>
      <select id={id} name={id} defaultValue={current} className={inputCls}>
        <option value="">Not specified</option>
        {withCurrent.map((o) => (
          <option key={o} value={o}>
            {o}
            {current === o && !options.includes(o) ? " (no longer on the list)" : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A titled group of fields, so a long register form stays readable. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-border p-4">
      <legend className="px-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </legend>
      <div className="space-y-4">{children}</div>
    </fieldset>
  );
}

const ROW_INPUT =
  "rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20";

/** Free text, because every institution names these differently. */
const PHONE_LABELS = ["Mobile", "Office", "Home", "Fax"];
const EMAIL_LABELS = ["Work", "Personal", "Alternate"];
const ADDRESS_LABELS = ["Home", "Office", "Mailing"];

type ContactRow = { kind: string; label: string | null; value: string };

/**
 * Extra phone numbers and email addresses, as repeatable rows.
 *
 * The whole set is submitted every time, including none at all, which is what
 * lets the save replace them wholesale: a row the user removed has to
 * disappear, and a diff against what the server already holds would be a second
 * source of truth to keep in step.
 */
function ContactRows({ initial }: { initial: ContactRow[] }) {
  const [rows, setRows] = useState<ContactRow[]>(initial);

  return (
    <div>
      <p className={labelCls}>Other phone numbers and emails</p>
      {rows.length === 0 && (
        <p className="mb-2 text-xs text-muted-foreground">None. The primary email and phone are above.</p>
      )}
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <select
              name="contactKind"
              value={r.kind}
              onChange={(e) =>
                setRows((rs) => rs.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))
              }
              aria-label="Contact kind"
              className={`${ROW_INPUT} w-28`}
            >
              <option value="PHONE">Phone</option>
              <option value="EMAIL">Email</option>
            </select>
            <input
              name="contactLabel"
              value={r.label ?? ""}
              onChange={(e) =>
                setRows((rs) => rs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))
              }
              list={r.kind === "EMAIL" ? "email-labels" : "phone-labels"}
              placeholder="Type"
              aria-label="Contact type"
              className={`${ROW_INPUT} w-32`}
            />
            <input
              name="contactValue"
              value={r.value}
              onChange={(e) =>
                setRows((rs) => rs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
              }
              placeholder={r.kind === "EMAIL" ? "name@example.com" : "+65 9123 4567"}
              aria-label="Contact value"
              className={`${ROW_INPUT} min-w-48 flex-1`}
            />
            <button
              type="button"
              onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
              aria-label="Remove this contact"
              className="rounded-lg border border-border px-2 py-1.5 text-xs text-red-700 hover:bg-muted"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <datalist id="phone-labels">
        {PHONE_LABELS.map((l) => <option key={l} value={l} />)}
      </datalist>
      <datalist id="email-labels">
        {EMAIL_LABELS.map((l) => <option key={l} value={l} />)}
      </datalist>
      <button
        type="button"
        onClick={() => setRows((rs) => [...rs, { kind: "PHONE", label: "", value: "" }])}
        className="mt-2 text-xs font-medium text-primary hover:underline"
      >
        + Add a phone or email
      </button>
    </div>
  );
}

type AddressRow = {
  label: string | null;
  line1: string | null;
  line2: string | null;
  line3: string | null;
  postal: string | null;
  country: string | null;
};

const BLANK_ADDRESS: AddressRow = {
  label: "",
  line1: "",
  line2: "",
  line3: "",
  postal: "",
  country: "",
};

/** Postal addresses, kept as separate lines because a label printer needs them. */
function AddressRows({ initial }: { initial: AddressRow[] }) {
  const [rows, setRows] = useState<AddressRow[]>(initial);
  const set = (i: number, patch: Partial<AddressRow>) =>
    setRows((rs) => rs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div>
      <p className={labelCls}>Addresses</p>
      {rows.length === 0 && <p className="mb-2 text-xs text-muted-foreground">None recorded.</p>}
      <div className="space-y-3">
        {rows.map((a, i) => (
          <div key={i} className="rounded-lg border border-border p-3">
            <div className="mb-2 flex items-center gap-2">
              <input
                name="addressLabel"
                value={a.label ?? ""}
                onChange={(e) => set(i, { label: e.target.value })}
                list="address-labels"
                placeholder="Type (e.g. Home)"
                aria-label="Address type"
                className={`${ROW_INPUT} w-40`}
              />
              <button
                type="button"
                onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                aria-label="Remove this address"
                className="ml-auto rounded-lg border border-border px-2 py-1.5 text-xs text-red-700 hover:bg-muted"
              >
                Remove
              </button>
            </div>
            <div className="space-y-2">
              {(["line1", "line2", "line3"] as const).map((k, li) => (
                <input
                  key={k}
                  name={`address${k[0].toUpperCase()}${k.slice(1)}`}
                  value={a[k] ?? ""}
                  onChange={(e) => set(i, { [k]: e.target.value })}
                  placeholder={`Address line ${li + 1}`}
                  aria-label={`Address line ${li + 1}`}
                  className={`${ROW_INPUT} w-full`}
                />
              ))}
              <div className="flex flex-wrap gap-2">
                <input
                  name="addressPostal"
                  value={a.postal ?? ""}
                  onChange={(e) => set(i, { postal: e.target.value })}
                  placeholder="Postal code"
                  aria-label="Postal code"
                  className={`${ROW_INPUT} w-36`}
                />
                <input
                  name="addressCountry"
                  value={a.country ?? ""}
                  onChange={(e) => set(i, { country: e.target.value })}
                  placeholder="Country"
                  aria-label="Country"
                  className={`${ROW_INPUT} w-48`}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
      <datalist id="address-labels">
        {ADDRESS_LABELS.map((l) => <option key={l} value={l} />)}
      </datalist>
      <button
        type="button"
        onClick={() => setRows((rs) => [...rs, { ...BLANK_ADDRESS }])}
        className="mt-2 text-xs font-medium text-primary hover:underline"
      >
        + Add an address
      </button>
    </div>
  );
}
