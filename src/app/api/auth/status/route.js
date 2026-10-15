import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getSettings } from "@/lib/localDb";
import { getDashboardAuthSession } from "@/lib/auth/dashboardSession";

// Password-only dashboard auth (OIDC/SAML were removed in this fork).
export async function GET() {
  try {
    const settings = await getSettings();
    const cookieStore = await cookies();
    const session = await getDashboardAuthSession(cookieStore.get("auth_token")?.value);
    return NextResponse.json({
      requireLogin: settings.requireLogin !== false,
      authMode: "password",
      hasPassword: !!settings.password,
      authenticated: !!session,
    });
  } catch {
    return NextResponse.json({
      requireLogin: true,
      authMode: "password",
      hasPassword: false,
      authenticated: false,
    });
  }
}
