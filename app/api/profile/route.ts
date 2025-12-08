/**
 * User Profile API
 * Returns the user's taste profile with anchor books and engagement signals
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserProfile, getUserTasteSummary } from "@/lib/features/userProfile";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("user_id") ?? "me";

  const [profile, summary] = await Promise.all([
    getUserProfile(userId),
    getUserTasteSummary(userId),
  ]);

  if (!profile) {
    return NextResponse.json(
      { error: "Profile not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({
    userId: profile.userId,
    anchors: profile.anchors,
    summary,
  });
}
