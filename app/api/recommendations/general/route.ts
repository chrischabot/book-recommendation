import { NextRequest, NextResponse } from "next/server";
import { generateGeneralCandidates } from "@/lib/recs/candidates";
import { rerankCandidates } from "@/lib/recs/rerank";
import { explainRecommendations } from "@/lib/recs/explain";
import { logger } from "@/lib/util/logger";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get("user_id") ?? "me";
    const page = parseInt(searchParams.get("page") ?? "1", 10);
    const pageSize = Math.min(
      parseInt(searchParams.get("page_size") ?? "24", 10),
      100
    );
    const includeExplanations = searchParams.get("explain") !== "false";
    const fastMode = searchParams.get("fast") !== "false"; // Fast by default

    logger.info("General recommendations request", { userId, page, pageSize });

    // Generate candidates
    const candidates = await generateGeneralCandidates({
      userId,
      limit: 500,
      useCache: true,
    });

    if (candidates.length === 0) {
      return NextResponse.json({
        recommendations: [],
        page,
        pageSize,
        total: 0,
        totalPages: 0,
      });
    }

    // Re-rank all candidates
    const ranked = await rerankCandidates(candidates, { limit: 100, userId });

    // Paginate
    const total = ranked.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pageRecs = ranked.slice(start, end);

    // Add explanations if requested
    let finalRecs;
    if (includeExplanations && pageRecs.length > 0) {
      finalRecs = await explainRecommendations(userId, pageRecs, { fast: fastMode });
    } else {
      finalRecs = pageRecs.map((rec) => ({
        ...rec,
        reasons: ["Recommended based on your reading history"],
      }));
    }

    return NextResponse.json({
      recommendations: finalRecs,
      page,
      pageSize,
      total,
      totalPages,
    });
  } catch (error) {
    logger.error("General recommendations error", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to generate recommendations" },
      { status: 500 }
    );
  }
}
