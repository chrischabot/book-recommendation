-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;

-- Note: Apache AGE is optional and requires a different base image
-- For now, we use pgvector/pgvector which has vector but not AGE
-- Graph features will be disabled until AGE is available
