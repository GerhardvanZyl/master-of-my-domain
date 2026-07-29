// Pending UI. Without it the router waits on the whole dynamic server render
// before painting anything, so clicking a card felt like a frozen click.
// ponytail: grey boxes in the real layout's shape, no shimmer library.
export default function Loading() {
  return (
    <section className="animate-pulse">
      <div className="mb-4 h-4 w-28 rounded bg-fill" />
      <div className="grid grid-cols-1 items-start gap-7 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-2">
          <div className="h-[400px] rounded-[18px] bg-fill" />
          <div className="grid grid-cols-3 gap-2">
            <div className="h-24 rounded-[12px] bg-fill sm:h-28" />
            <div className="h-24 rounded-[12px] bg-fill sm:h-28" />
            <div className="h-24 rounded-[12px] bg-fill sm:h-28" />
          </div>
          <div className="h-64 rounded-2xl bg-fill" />
        </div>
        <div className="flex flex-col gap-4">
          <div className="h-9 w-3/4 rounded bg-fill" />
          <div className="h-6 w-1/3 rounded bg-fill" />
          <div className="h-20 rounded-xl bg-fill" />
          <div className="h-40 rounded-2xl bg-fill" />
        </div>
      </div>
    </section>
  );
}
