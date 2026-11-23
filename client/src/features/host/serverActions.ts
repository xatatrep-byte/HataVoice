/** What the house menu offers for a server of the list: leaving it, deleting it, or only taking it off the list. */
export type ServerActions = { leave: boolean; remove: "delete" | "forget" | null };

/**
 * `hosted` is the address the server of this PC is reached by here (null: none here, undefined: not known yet); `me`
 * is who we are on the server, null while its state does not load (it is off, gone, or its own internet address does
 * not answer from inside the home network).
 *
 * The server of this PC can be deleted even while it is off. Any other one we own, or one that does not answer at all,
 * can be taken off the list: a server that never loads must never be stuck there. Leaving is for a member.
 */
export function serverActions(address: string, hosted: string | null | undefined, me: { is_owner: boolean } | null): ServerActions {
  const here = hosted !== undefined && address === hosted;
  const ours = me === null || me.is_owner;
  return {
    leave: me !== null && !me.is_owner,
    remove: here && ours ? "delete" : hosted !== undefined && !here && ours ? "forget" : null,
  };
}
