// Pending UI — the compare render pulls every photo + map for up to 4 listings.
export default function Loading() {
  return (
    <section className="animate-pulse space-y-6">
      <div className="h-10 w-80 rounded bg-fill" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="h-[150px] rounded-2xl bg-fill" />
        <div className="h-[150px] rounded-2xl bg-fill" />
        <div className="h-[150px] rounded-2xl bg-fill" />
        <div className="h-[150px] rounded-2xl bg-fill" />
      </div>
      <div className="h-96 rounded-2xl bg-fill" />
    </section>
  );
}
