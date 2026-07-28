/** The two agents reseat syncs between. */
export type Side = "claude" | "codex";

/** One visible conversation turn, as carried between the agents. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}
