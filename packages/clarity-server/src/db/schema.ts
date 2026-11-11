export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    allowed_domains TEXT[] NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_clicks (
    id VARCHAR(100) PRIMARY KEY,
    project_id VARCHAR(100) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_url TEXT NOT NULL,
    device VARCHAR(20) NOT NULL DEFAULT 'desktop',
    hash VARCHAR(100) NOT NULL,
    selector TEXT NOT NULL,
    e_x INT NOT NULL,
    e_y INT NOT NULL,
    timestamp BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_clicks_lookup
    ON raw_clicks (project_id, page_url, device, timestamp);

CREATE TABLE IF NOT EXISTS raw_scrolls (
    id VARCHAR(100) PRIMARY KEY,
    project_id VARCHAR(100) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_url TEXT NOT NULL,
    device VARCHAR(20) NOT NULL DEFAULT 'desktop',
    session_id VARCHAR(100) NOT NULL,
    max_scroll_reach_y INT NOT NULL,
    timestamp BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_raw_scrolls_lookup
    ON raw_scrolls (project_id, page_url, device, timestamp);

CREATE TABLE IF NOT EXISTS page_snapshots (
    id VARCHAR(255) PRIMARY KEY,
    project_id VARCHAR(100) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_url TEXT NOT NULL,
    device VARCHAR(20) NOT NULL DEFAULT 'desktop',
    dom_hash VARCHAR(100) NOT NULL,
    raw_payload TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    CONSTRAINT uq_page_snapshot UNIQUE (project_id, page_url, device)
);

ALTER TABLE raw_clicks ADD COLUMN IF NOT EXISTS client_time BIGINT;
ALTER TABLE raw_scrolls ADD COLUMN IF NOT EXISTS client_time BIGINT;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS exclude_patterns TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS version BIGINT;
ALTER TABLE raw_scrolls ADD COLUMN IF NOT EXISTS viewport_height INT;

CREATE TABLE IF NOT EXISTS page_index (
    project_id VARCHAR(100) NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_key TEXT NOT NULL,
    device VARCHAR(20) NOT NULL,
    last_url TEXT NOT NULL,
    first_seen BIGINT NOT NULL,
    last_seen BIGINT NOT NULL,
    views BIGINT NOT NULL DEFAULT 0,
    clicks BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, page_key, device)
);

-- project_id '' holds drops not tied to a project; no foreign key so unknown ids can be counted
CREATE TABLE IF NOT EXISTS ingest_drops (
    project_id VARCHAR(100) NOT NULL,
    reason VARCHAR(20) NOT NULL,
    count BIGINT NOT NULL,
    last_at BIGINT NOT NULL,
    PRIMARY KEY (project_id, reason)
);

DROP INDEX IF EXISTS idx_raw_clicks_group;

-- Retention deletes by age across all projects
CREATE INDEX IF NOT EXISTS idx_raw_clicks_timestamp ON raw_clicks (timestamp);
CREATE INDEX IF NOT EXISTS idx_raw_scrolls_timestamp ON raw_scrolls (timestamp);
CREATE INDEX IF NOT EXISTS idx_page_snapshots_timestamp ON page_snapshots (timestamp);
CREATE INDEX IF NOT EXISTS idx_page_index_last_seen ON page_index (last_seen);

CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(100) PRIMARY KEY,
    applied_at BIGINT NOT NULL
);
`;
