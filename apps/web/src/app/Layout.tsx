import { Link, Outlet } from "@tanstack/react-router";

const NAV = [
  { to: "/" as const, label: "Today" },
  { to: "/board" as const, label: "Board" }
];

export function Layout() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 px-4 py-3">
        <nav className="flex items-center gap-4">
          <span className="font-semibold">◤ CryptoEdge Lab</span>
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="text-sm text-slate-400 hover:text-slate-100 [&.active]:text-slate-100"
              activeProps={{ className: "text-slate-100" }}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="p-4">
        <Outlet />
      </main>
    </div>
  );
}
