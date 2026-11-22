-- Where a document's bytes are in R2. Uploads stream to R2 before their format is known, and a PDF is not stored a
-- second time, so the keys are recorded. NULL for older documents: sourceKey(id, format) and documentKey(id).
ALTER TABLE documents ADD COLUMN source_key TEXT;
ALTER TABLE documents ADD COLUMN pdf_key TEXT;
