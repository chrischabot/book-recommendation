import { NextRequest, NextResponse } from "next/server";
import { generateByCategoryCandidates } from "@/lib/recs/candidates";
import { rerankCandidates } from "@/lib/recs/rerank";
import { explainRecommendations } from "@/lib/recs/explain";
import { getCategoryConstraints, getCategorySlugs } from "@/lib/config/categories";
import { logger } from "@/lib/util/logger";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const userId = searchParams.get("user_id") ?? "me";
    const slug = searchParams.get("slug");
    const page = parseInt(searchParams.get("page") ?? "1", 10);
    const pageSize = Math.min(
      parseInt(searchParams.get("page_size") ?? "24", 10),
      100
    );
    const includeExplanations = searchParams.get("explain") !== "false";
    const fastMode = searchParams.get("fast") !== "false"; // Fast by default

    if (!slug) {
      // Return list of available categories
      const categories = getCategorySlugs();
      return NextResponse.json({ categories });
    }

    // Validate category
    const constraints = getCategoryConstraints(slug);
    if (!constraints) {
      return NextResponse.json(
        { error: `Unknown category: ${slug}` },
        { status: 400 }
      );
    }

    logger.info("By-category recommendations request", { userId, slug, page, pageSize });

    // Generate candidates
    const candidates = await generateByCategoryCandidates({
      userId,
      categorySlug: slug,
      limit: 300,
      useCache: true,
    });

    if (candidates.length === 0) {
      return NextResponse.json({
        category: {
          slug,
          description: constraints.description,
        },
        recommendations: [],
        page,
        pageSize,
        total: 0,
        totalPages: 0,
      });
    }

    // Re-rank
    const ranked = await rerankCandidates(candidates, { limit: 100, userId });

    // Paginate
    const total = ranked.length;
    const totalPages = Math.ceil(total / pageSize);
    const start = (page - 1) * pageSize;
    const end = start + pageSize;
    const pageRecs = ranked.slice(start, end);

    // Add explanations
    let finalRecs;
    if (includeExplanations && pageRecs.length > 0) {
      finalRecs = await explainRecommendations(userId, pageRecs, { fast: fastMode });
    } else {
      finalRecs = pageRecs.map((rec) => ({
        ...rec,
        reasons: [`Recommended in ${slug.replace("-", " ")}`],
      }));
    }

    return NextResponse.json({
      category: {
        slug,
        description: constraints.description,
      },
      recommendations: finalRecs,
      page,
      pageSize,
      total,
      totalPages,
    });
  } catch (error) {
    logger.error("By-category recommendations error", { error: String(error) });
    return NextResponse.json(
      { error: "Failed to generate recommendations" },
      { status: 500 }
    );
  }
}
