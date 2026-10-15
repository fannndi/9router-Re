import { proxy as dashboardProxy } from "./dashboardGuard";

// Lean fork: the Xiaomi MiMo session-login proxy went away with the OAuth
// providers, so the dashboard auth guard is the only thing left to run.
export default function proxy(request) {
  return dashboardProxy(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
