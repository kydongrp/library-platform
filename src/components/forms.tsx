"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { idleState, type ActionState } from "@/lib/types";
import { useToast } from "@/components/toast";
import { buttonVariants } from "@/components/ui";

type ActionFn = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/** Submit button that reflects the enclosing form's pending state. */
export function SubmitButton({
  children,
  pendingLabel,
  variant = "primary",
  className = "",
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: keyof typeof buttonVariants;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={`${buttonVariants[variant]} ${className}`}
    >
      {pending ? pendingLabel ?? "Working…" : children}
    </button>
  );
}

/**
 * Self-contained button that runs a server action with a fixed set of hidden
 * inputs and surfaces the result as a toast. Used for one-click circulation
 * actions (borrow, return, renew, cancel) inside lists and tables.
 */
export function ActionButton({
  action,
  fields,
  children,
  pendingLabel,
  variant = "primary",
  className = "",
  confirm,
}: {
  action: ActionFn;
  fields: Record<string, string>;
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: keyof typeof buttonVariants;
  className?: string;
  confirm?: string;
}) {
  const [state, formAction] = useActionState(action, idleState);
  const toast = useToast();

  useEffect(() => {
    if (state.ok !== undefined && state.message) toast(state.message, state.ok);
  }, [state, toast]);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <SubmitButton variant={variant} pendingLabel={pendingLabel} className={className}>
        {children}
      </SubmitButton>
    </form>
  );
}

/**
 * Wraps a create/edit form, runs the action through useActionState, and shows
 * the result as a toast. Children receive the live state for inline errors.
 */
export function StatefulForm({
  action,
  children,
  className = "",
}: {
  action: ActionFn;
  children: React.ReactNode | ((state: ActionState) => React.ReactNode);
  className?: string;
}) {
  const [state, formAction] = useActionState(action, idleState);
  const toast = useToast();

  useEffect(() => {
    if (state.ok !== undefined && state.message) toast(state.message, state.ok);
  }, [state, toast]);

  return (
    <form action={formAction} className={className}>
      {typeof children === "function" ? children(state) : children}
    </form>
  );
}
