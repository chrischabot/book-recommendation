import { NextRequest, NextResponse } from "next/server";
import { generateByBookCandidates } from "@/lib/recs/candidates";
import { rerankCandidates } from "@/lib/recs/rerank";
import { explainRecommendations } from "@/lib/recs/explain";
import { query } from "@/lib/db/pool";
import { logger } from "@/lib/util/logger";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get("user_id") ?? "me";
    const workIdParam = searchParams.get("work_id");
    const limit = Math.min(
      parseInt(searchParams.get("k") ?? "100", 10),
      200
    );
    const includeExplanations = searchParams.get("explain") !== "false";
    const fastMode = searchParams.get("fast") !== "false"; // Fast by default

    if (!workIdParam) {
      return NextResponse.json(
        { error: "work_id is required" },
        { status: 400 }
      );
    }

    const seedWorkId = parseInt(workIdParam, 10);
    if (isNaN(seedWorkId)) {
      return NextResponse.json(
        { error: "work_id must be a number" },
        { status: 400 }
      );
    }

    logger.info("By-book recommendations request", { userId, seedWorkId, limit });

    // Get seed work info
    const { rows: seedRows } = await query<{ title: string }>(
      `SELECT title FROM "Work" WHERE id = $1`,
      [seedWorkId]
    );

    if (seedRows.length === 0) {
      return NextResponse.json(
        { error: "Work not found" },
        { status: 404 }
      );
    }

    const seedTitle = seedRows[0].title;

    // Generate candidates
    const candidates = await generateByBookCandidates({
      userId,
      seedWorkId,
      limit: limit * 2,
      useCache: true,
    });

    if (candidates.length === 0) {
      return NextResponse.json({
        seedWork: { id: seedWorkId, title: seedTitle },
        recommendations: [],
        total: 0,
      });
    }

    // Re-rank
    const ranked = await rerankCandidates(candidates, { limit, userId });

    // Add explanations
    let finalRecs;
    if (includeExplanations && ranked.length > 0) {
      finalRecs = await explainRecommendations(userId, ranked, { fast: fastMode });
    } else {
      finalRecs = ranked.map((rec) => ({
        ...rec,
        reasons: [`Similar to "${seedTitle}"`],
      }));
    }

    return NextResponse.json({
      seedWork: { id: seedWorkId, title: seedTitle },
      recommendations: finalRecs,
      total: finalRecs.length,
    });
  } catch (error) {
    logger.error("By-book recommendations error", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to generate recommendations" },
      { status: 500 }
    );
  }
}
