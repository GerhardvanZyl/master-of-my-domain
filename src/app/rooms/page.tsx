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
    <Link href={href} className={`chip ${active ? "chip-on" : "hover:border-forest"}`}>
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
    <section className="rise space-y-5">
      <div>
        <div className="eyebrow mb-1.5">Photos by room</div>
        <h1 className="font-serif text-[38px] leading-none">Room-by-room</h1>
        <p className="mt-2 text-[13.5px] text-mute">
          Every tagged photo of a room, across all properties, side by side.
        </p>
      </div>

      {nothingTagged ? (
        <p className="card p-8 text-sm text-mute">
          No tagged photos yet. In a terminal, run <code>claude</code> and use the
          <strong> tag-photos</strong> skill (or ask it to “tag the photos”). See{" "}
          <code>CLAUDE.md</code>.
        </p>
      ) : (
        <>
          <div className="space-y-2">
            <div className="label-cap">By room type</div>
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
              {rooms.length === 0 && <span className="text-sm text-mute">none</span>}
            </div>
          </div>

          <div className="space-y-2">
            <div className="label-cap">Similarity groups</div>
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
                <span className="text-sm text-mute">
                  none yet — the tagging job creates these
                </span>
              )}
            </div>
          </div>

          {heading ? (
            <div className="space-y-3 border-t border-line pt-5">
              <h2 className="font-serif text-2xl">{heading}</h2>
              <RoomColumns columns={columns} />
            </div>
          ) : (
            <p className="pt-2 text-sm text-mute">
              Pick a room type or a similarity group above to compare photos side
              by side.
            </p>
          )}
        </>
      )}
    </section>
  );
}
