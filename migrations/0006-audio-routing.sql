-- Additive metadata for server-side Auto. `model` remains the concrete core
-- contract that ran; `routing_request` records the distinct "auto" request.
ALTER TABLE jobs ADD COLUMN routing_request TEXT;
ALTER TABLE jobs ADD COLUMN source_type TEXT;
ALTER TABLE jobs ADD COLUMN analysis TEXT;
