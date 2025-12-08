/**
 * Favorites Management API
 * Add or remove books from user's profile favorites (anchor overrides)
 */

import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";

/**
 * DELETE - Remove a book from favorites
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { workId, userId = "me" } = body;

    if (!workId) {
      return NextResponse.json(
        { error: "workId is required" },
        { status: 400 }
      );
    }

    // Add to Block table to exclude from profile (use INSERT WHERE NOT EXISTS for partial index)
    await query(
      `INSERT INTO "Block" (user_id, work_id, created_at)
       SELECT $1, $2, NOW()
       WHERE NOT EXISTS (
         SELECT 1 FROM "Block" WHERE user_id = $1 AND work_id = $2
       )`,
      [userId, workId]
    );

    logger.info("Removed book from favorites", { userId, workId });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to remove favorite", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to remove favorite" },
      { status: 500 }
    );
  }
}

/**
 * POST - Add a book to favorites (remove from Block if present)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { workId, userId = "me" } = body;

    if (!workId) {
      return NextResponse.json(
        { error: "workId is required" },
        { status: 400 }
      );
    }

    // Remove from Block table to include in profile
    await query(
      `DELETE FROM "Block" WHERE user_id = $1 AND work_id = $2`,
      [userId, workId]
    );

    // Optionally boost this work in the user's profile
    // For now, just unblock it - future: store explicit favorites

    logger.info("Added book to favorites", { userId, workId });

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error("Failed to add favorite", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to add favorite" },
      { status: 500 }
    );
  }
}

/**
 * GET - Check if a book is in favorites
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const workId = searchParams.get("work_id");
  const userId = searchParams.get("user_id") ?? "me";

  if (!workId) {
    return NextResponse.json(
      { error: "work_id is required" },
      { status: 400 }
    );
  }

  try {
    // Check if blocked (not favorite)
    const { rows } = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM "Block" WHERE user_id = $1 AND work_id = $2`,
      [userId, parseInt(workId, 10)]
    );

    const isBlocked = parseInt(rows[0]?.count ?? "0", 10) > 0;

    // Check if in user's read history (could be a favorite)
    const { rows: eventRows } = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM "UserEvent" WHERE user_id = $1 AND work_id = $2`,
      [userId, parseInt(workId, 10)]
    );

    const isInHistory = parseInt(eventRows[0]?.count ?? "0", 10) > 0;

    return NextResponse.json({
      workId: parseInt(workId, 10),
      isFavorite: isInHistory && !isBlocked,
      isBlocked,
      isInHistory,
    });
  } catch (error) {
    logger.error("Failed to check favorite status", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to check favorite status" },
      { status: 500 }
    );
  }
}
