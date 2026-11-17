-- Anonymous research staging. No organization business data is inserted by these routes.
CREATE TABLE IF NOT EXISTS public.higuchi_preview_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text NOT NULL,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS higuchi_preview_session_token_uq ON public.higuchi_preview_sessions(token_hash);
CREATE INDEX IF NOT EXISTS higuchi_preview_session_expiry_idx ON public.higuchi_preview_sessions(expires_at);
CREATE TABLE IF NOT EXISTS public.higuchi_preview_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.higuchi_preview_sessions(id) ON DELETE CASCADE,
  input jsonb NOT NULL, state jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued', revision integer NOT NULL DEFAULT 0, generation integer NOT NULL DEFAULT 0,
  stage_index integer NOT NULL DEFAULT 0, attempts integer NOT NULL DEFAULT 0, retry_count integer NOT NULL DEFAULT 0,
  locked_by text, lease_until timestamptz, run_after timestamptz NOT NULL DEFAULT now(),
  error_code text, error_message text, error_retryable integer NOT NULL DEFAULT 0,
  claimed_organization_id uuid REFERENCES public.organizations(id) ON DELETE RESTRICT,
  claimed_project_id uuid, claimed_at timestamptz,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT higuchi_preview_run_stage_check CHECK (stage_index BETWEEN 0 AND 6),
  CONSTRAINT higuchi_preview_run_status_check CHECK (status IN ('queued','running','ready','failed','claimed'))
);
CREATE INDEX IF NOT EXISTS higuchi_preview_run_session_idx ON public.higuchi_preview_runs(session_id);
CREATE INDEX IF NOT EXISTS higuchi_preview_run_due_idx ON public.higuchi_preview_runs(status,run_after);
CREATE INDEX IF NOT EXISTS higuchi_preview_run_expiry_idx ON public.higuchi_preview_runs(expires_at);
CREATE TABLE IF NOT EXISTS public.higuchi_preview_daily_limits (
  ip_day_hash text PRIMARY KEY, day text NOT NULL, runs integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS higuchi_preview_limit_day_idx ON public.higuchi_preview_daily_limits(day);
CREATE TABLE IF NOT EXISTS public.higuchi_preview_worker_slots (
  slot integer PRIMARY KEY CHECK(slot BETWEEN 1 AND 2), owner text, lease_until timestamptz
);
INSERT INTO public.higuchi_preview_worker_slots(slot) VALUES(1),(2) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS public.higuchi_preview_ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES public.higuchi_preview_runs(id) ON DELETE RESTRICT,
  request_key text NOT NULL, month text NOT NULL, model text NOT NULL,
  reserved_micros integer NOT NULL, actual_micros integer, input_tokens integer, output_tokens integer,
  search_calls integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'reserved', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS higuchi_preview_ai_request_uq ON public.higuchi_preview_ai_usage(request_key);
CREATE INDEX IF NOT EXISTS higuchi_preview_ai_month_idx ON public.higuchi_preview_ai_usage(month);
CREATE INDEX IF NOT EXISTS higuchi_preview_ai_run_idx ON public.higuchi_preview_ai_usage(run_id);
