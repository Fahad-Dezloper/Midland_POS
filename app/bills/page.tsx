import Link from "next/link";

import BillsManager from "./bills-manager";

export const metadata = {
  title: "Bills — Midland",
};

export default function BillsPage() {
  return (
    <main className="mx-auto flex w-full min-h-0 max-w-[1400px] flex-1 flex-col overflow-hidden px-3 py-3 sm:px-5 lg:px-6 xl:px-8 xl:py-5">
      <header className="mb-3 flex shrink-0 items-start justify-between gap-4 xl:mb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight xl:text-3xl">
            Midland <span className="text-accent">Bills</span>
          </h1>
          <p className="mt-0.5 text-xs text-neutral-500 xl:text-sm">
            View, edit, or delete recorded sales. Edits update the report too.
          </p>
        </div>
        <Link
          href="/"
          className="shrink-0 rounded-xl border border-accent/40 px-3 py-2 text-sm font-medium text-accent transition hover:bg-accent/5"
        >
          ← Back to till
        </Link>
      </header>

      <BillsManager />
    </main>
  );
}
