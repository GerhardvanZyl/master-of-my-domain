import Link from "next/link";
import RoomColumns from "@/components/RoomColumns";
import {
  roomTypeCounts,
  imagesByRoom,
  listGroups,
  groupMembers,
} from "@/db/queries/rooms";

export const dynamic = "force-dynamic";

function Chip({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-sm ${
        active
          ? "border-blue-600 bg-blue-600 text-white"
          : "border-neutral-300 hover:border-neutral-400 dark:border-neutral-700"
      }`}
    >
      {children}
    </Link>
  );
}

export default async function RoomsPage({
  searchParams,
}: {
  searchParams: Promise<{ room?: string; group?: string }>;
}) {
  const { room, group } = await searchParams;
  const rooms = roomTypeCounts();
  const groups = listGroups();

  const columns = room
    ? imagesByRoom(room)
    : group
      ? groupMembers(group)
      : [];

  const heading = room
    ? `All “${room}” photos across properties`
    : group
      ? `Similarity group: ${groups.find((g) => g.id === group)?.label ?? group}`
      : null;

  const nothingTagged = rooms.length === 0 && groups.length === 0;

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-semibold">Compare rooms</h1>

      {nothingTagged ? (
        <p className="text-sm text-neutral-500">
          No tagged photos yet. In a terminal, run <code>claude</code> and use the
          <strong> tag-photos</strong> skill (or ask it to “tag the photos”). See{" "}
          <code>CLAUDE.md</code>.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-neutral-400">
              By room type
            </div>
            <div className="flex flex-wrap gap-2">
              {rooms.map((r) => (
                <Chip
                  key={r.roomType}
                  href={`/rooms?room=${encodeURIComponent(r.roomType)}`}
                  active={room === r.roomType}
                >
                  {r.roomType} ({r.count})
                </Chip>
              ))}
              {rooms.length === 0 && (
                <span className="text-sm text-neutral-500">none</span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-neutral-400">
              Similarity groups
            </div>
            <div className="flex flex-wrap gap-2">
              {groups.map((g) => (
                <Chip
                  key={g.id}
                  href={`/rooms?group=${encodeURIComponent(g.id)}`}
                  active={group === g.id}
                >
                  {g.label} ({g.members})
                </Chip>
              ))}
              {groups.length === 0 && (
                <span className="text-sm text-neutral-500">
                  none yet — the tagging job creates these
                </span>
              )}
            </div>
          </div>

          {heading ? (
            <div className="space-y-3 pt-2">
              <h2 className="text-sm font-semibold">{heading}</h2>
              <RoomColumns columns={columns} />
            </div>
          ) : (
            <p className="pt-2 text-sm text-neutral-500">
              Pick a room type or a similarity group above to compare photos side
              by side.
            </p>
          )}
        </>
      )}
    </div>
  );
}
