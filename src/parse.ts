import type { CommentEvent } from "./types";

interface Entry {
  id?: string;
  changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
}
interface Payload {
  object?: string;
  entry?: Entry[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
}

/**
 * Flattens a Meta webhook body into comment events we care about.
 * Anything unrecognised is dropped silently — Meta sends plenty of fields we
 * never subscribed to intentionally, plus edits and deletions.
 */
export function parseComments(body: unknown): CommentEvent[] {
  const payload = (typeof body === "object" && body !== null ? body : {}) as Payload;
  const out: CommentEvent[] = [];

  for (const entry of Array.isArray(payload.entry) ? payload.entry : []) {
    if (typeof entry !== "object" || entry === null) continue;
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      if (typeof change !== "object" || change === null) continue;
      const v = (typeof change.value === "object" && change.value !== null
        ? change.value
        : {}) as Record<string, unknown>;

      if (payload.object === "instagram" && change.field === "comments") {
        const commentId = str(v.id);
        const text = str(v.text);
        if (!commentId || !text) continue;
        const from = v.from as Record<string, unknown> | undefined;
        const media = v.media as Record<string, unknown> | undefined;
        out.push({
          platform: "instagram",
          commentId,
          text,
          mediaId: str(media?.id),
          authorId: str(from?.id),
          authorName: str(from?.username),
          accountId: str(entry.id),
          ownerId: str(entry.id),
          isReply: Boolean(v.parent_id),
        });
        continue;
      }

      if (payload.object === "page" && change.field === "feed") {
        // The `feed` field is a firehose: posts, reactions, shares, edits.
        // Only brand-new comments should trigger a DM.
        if (v.item !== "comment" || v.verb !== "add") continue;
        const commentId = str(v.comment_id);
        if (!commentId) continue;
        // A sticker- or photo-only comment carries no `message` at all — still a
        // genuine comment, so it must reach rule matching (for an "any" catch-all)
        // rather than being dropped as noise.
        const text = str(v.message) ?? "";
        const from = v.from as Record<string, unknown> | undefined;
        const postId = str(v.post_id);
        out.push({
          platform: "facebook",
          commentId,
          text,
          mediaId: postId,
          authorId: str(from?.id),
          authorName: str(from?.name),
          accountId: str(entry.id),
          ownerId: str(entry.id),
          // On a top-level comment Facebook sets parent_id to the post id.
          isReply: Boolean(v.parent_id) && str(v.parent_id) !== postId,
        });
      }
    }
  }

  return out;
}
