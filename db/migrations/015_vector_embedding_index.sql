-- Create IVFFlat vector index for fast similarity searches on Work.embedding
-- This enables efficient k-nearest-neighbor queries for recommendations
--
-- Prerequisites:
-- - Works must have embeddings (run pnpm features:embed first)
-- - Embeddings must be dimension-reduced to 1536 (configured in env)
-- - IVFFlat needs existing data for training, so run after embeddings exist
--
-- Performance notes:
-- - lists=500 is appropriate for ~1-5M rows with embeddings
-- - Use lists = sqrt(num_rows) as a general guideline
-- - CONCURRENTLY avoids locking but takes longer

-- Create the IVFFlat index for cosine similarity searches
-- This dramatically speeds up the knn queries in lib/db/sql.ts
CREATE INDEX CONCURRENTLY IF NOT EXISTS work_embedding_ivfflat
ON "Work" USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 500)
WHERE embedding IS NOT NULL;

-- After this migration runs, vector similarity queries like:
--   SELECT id, 1 - (embedding <=> $user_vec) AS sim
--   FROM "Work" WHERE embedding IS NOT NULL
--   ORDER BY embedding <=> $user_vec LIMIT 100
-- Will use the index instead of full table scans.
