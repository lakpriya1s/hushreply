import assert from "node:assert/strict";
import { test } from "node:test";
import { parseComments } from "../src/parse.ts";

test("parses an Instagram comment webhook", () => {
  const events = parseComments({
    object: "instagram",
    entry: [
      {
        id: "17841400000000000",
        time: 1_700_000_000,
        changes: [
          {
            field: "comments",
            value: {
              from: { id: "9876", username: "curious_person" },
              media: { id: "media_1", media_product_type: "FEED" },
              id: "comment_1",
              text: "SOMETHING",
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(events, [
    {
      platform: "instagram",
      commentId: "comment_1",
      text: "SOMETHING",
      mediaId: "media_1",
      authorId: "9876",
      authorName: "curious_person",
      accountId: "17841400000000000",
      ownerId: "17841400000000000",
      isReply: false,
    },
  ]);
});

test("flags an Instagram reply via parent_id", () => {
  const [event] = parseComments({
    object: "instagram",
    entry: [
      {
        id: "ig1",
        changes: [
          {
            field: "comments",
            value: { id: "c2", text: "SOMETHING", parent_id: "c1", from: { id: "u" } },
          },
        ],
      },
    ],
  });
  assert.equal(event!.isReply, true);
});

function pageFeed(value: Record<string, unknown>) {
  return { object: "page", entry: [{ id: "page_1", changes: [{ field: "feed", value }] }] };
}

test("parses a new Facebook Page comment", () => {
  const events = parseComments(
    pageFeed({
      item: "comment",
      verb: "add",
      comment_id: "post_1_comment_1",
      post_id: "post_1",
      parent_id: "post_1",
      from: { id: "user_1", name: "Real Person" },
      message: "SOMETHING",
    }),
  );

  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    platform: "facebook",
    commentId: "post_1_comment_1",
    text: "SOMETHING",
    mediaId: "post_1",
    authorId: "user_1",
    authorName: "Real Person",
    accountId: "page_1",
    ownerId: "page_1",
    // parent_id equal to post_id means top-level, not a reply.
    isReply: false,
  });
});

test("ignores Facebook feed noise that must not trigger a DM", () => {
  const noise = [
    { item: "comment", verb: "edited", comment_id: "c", post_id: "p", message: "SOMETHING" },
    { item: "comment", verb: "remove", comment_id: "c", post_id: "p", message: "SOMETHING" },
    { item: "reaction", verb: "add", post_id: "p", message: "SOMETHING" },
    { item: "status", verb: "add", post_id: "p", message: "SOMETHING" },
    { item: "share", verb: "add", post_id: "p", share_id: "s" },
  ];
  for (const value of noise) {
    assert.deepEqual(parseComments(pageFeed(value)), [], JSON.stringify(value));
  }
});

test("a sticker/photo Facebook comment with no message still reaches rule matching", () => {
  const [event] = parseComments(
    pageFeed({
      item: "comment",
      verb: "add",
      comment_id: "c",
      post_id: "p",
      from: { id: "user_1", name: "Real Person" },
    }),
  );
  assert.deepEqual(event, {
    platform: "facebook",
    commentId: "c",
    text: "",
    mediaId: "p",
    authorId: "user_1",
    authorName: "Real Person",
    accountId: "page_1",
    ownerId: "page_1",
    isReply: false,
  });
});

test("detects a genuine Facebook comment reply", () => {
  const [event] = parseComments(
    pageFeed({
      item: "comment",
      verb: "add",
      comment_id: "c2",
      post_id: "p1",
      parent_id: "c1",
      message: "SOMETHING",
      from: { id: "u" },
    }),
  );
  assert.equal(event!.isReply, true);
});

test("tolerates junk payloads without throwing", () => {
  assert.deepEqual(parseComments({}), []);
  assert.deepEqual(parseComments(null), []);
  assert.deepEqual(parseComments({ object: "page", entry: [{}] }), []);
  assert.deepEqual(parseComments({ object: "instagram", entry: [{ changes: [{}] }] }), []);
  assert.deepEqual(parseComments({ object: "whatsapp", entry: [] }), []);
});

test("handles multiple entries and changes in one delivery", () => {
  const events = parseComments({
    object: "instagram",
    entry: [
      {
        id: "ig1",
        changes: [
          { field: "comments", value: { id: "c1", text: "one", from: { id: "u1" } } },
          { field: "mentions", value: { comment_id: "x", media_id: "y" } },
        ],
      },
      {
        id: "ig1",
        changes: [{ field: "comments", value: { id: "c2", text: "two", from: { id: "u2" } } }],
      },
    ],
  });
  assert.deepEqual(
    events.map((e) => e.commentId),
    ["c1", "c2"],
  );
});
