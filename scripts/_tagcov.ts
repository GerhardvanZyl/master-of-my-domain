import { sqlite } from "../src/db/client";
const rows = sqlite
  .prepare(
    `SELECT p.id AS id
      FROM properties p
      JOIN images i ON i.property_id = p.id
      JOIN image_tags t ON t.image_id = i.id
      WHERE t.room_type = 'bathroom'
      GROUP BY p.id
      HAVING COUNT(*) > 1
      LIMIT 3`,
  )
  .all() as { id: string }[];
console.log(rows.map((r) => r.id).join(","));
