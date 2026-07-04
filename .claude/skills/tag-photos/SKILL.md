---
name: tag-photos
description: Tag property listing photos by room type and cluster comparable rooms across properties, so the app can show them side by side. Use when the user asks to "tag the photos", "tag rooms", "classify the photos", or "group similar rooms" in this property-compare repo.
---

# Tag property photos

You classify each listing photo by room type and build cross-property comparison
groups. You are the vision model — **Read each image file** and decide from what
you actually see, never from the filename or URL. All writes go through the npm
CLIs below (idempotent; safe to re-run).

## Room vocabulary (use these exact strings)
`kitchen` · `bathroom` · `bedroom` · `living` · `dining` · `exterior` · `other`

## Steps

1. **List untagged images**
   ```
   npm run tag:list
   ```
   Output is a JSON array; each item has `imageId`, `propertyId`, `address`,
   `ordinal`, and `absPath`. If the array is empty, everything is already tagged —
   skip to step 4.

2. **Tag each image.** For every item: use the **Read** tool on its `absPath` to
   view the photo, decide the room type, then:
   ```
   npm run tag:set -- --image=<imageId> --room=<type>
   ```
   Tag in batches by property so you keep context. Re-tagging overwrites, so a
   correction is just another `tag:set`.

3. **Build cross-property comparison groups.** For each room type that appears in
   **two or more different properties**, create/reuse a group and add one
   representative photo per property:
   ```
   npm run group:ensure -- --label="kitchen" --room=kitchen   # prints {groupId}
   npm run group:add -- --group=<groupId> --image=<imageId>   # repeat per property
   ```
   **Rule: at most one image per property per group** — pick the most
   representative shot so the side-by-side view has one clean column per property.
   When a plain room split wouldn't be a fair comparison (e.g. renovated vs
   original), make finer labels like `"kitchen — renovated"`.

4. **Confirm and report**
   ```
   npm run tag:status
   ```
   Verify `untagged: 0`. Tell the user how many photos you tagged, the room
   breakdown, and which comparison groups you created. Point them to `/rooms` in
   the app to view the results.

## Notes
- Ambiguous/mixed shots (e.g. open-plan kitchen+living): pick the dominant room
  for the tag, and you can add the image to multiple similarity groups.
- Filter large batches with `npm run tag:list -- --property=<id>` or `--limit=N`.
