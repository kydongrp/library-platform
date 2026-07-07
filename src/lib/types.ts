// Result shape returned by server actions, compatible with React's
// useActionState. `ok: undefined` represents the initial (idle) state.
export type ActionState = {
  ok?: boolean;
  message?: string;
};

export const idleState: ActionState = {};
