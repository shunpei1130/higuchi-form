CREATE TABLE IF NOT EXISTS higuchi_prospect_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, source text NOT NULL,
  published boolean NOT NULL DEFAULT false, row_count integer NOT NULL DEFAULT 0, revision integer NOT NULL DEFAULT 1,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT higuchi_prospect_dataset_source_check CHECK (source IN ('csv','xlsx','database'))
);
CREATE INDEX IF NOT EXISTS higuchi_prospect_dataset_public_idx ON higuchi_prospect_datasets(published);
CREATE TABLE IF NOT EXISTS higuchi_prospect_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dataset_id uuid NOT NULL REFERENCES higuchi_prospect_datasets(id) ON DELETE CASCADE,
  external_key text NOT NULL, company_name text NOT NULL, domain text NOT NULL DEFAULT '', description text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '', employee_count integer, monthly_traffic integer, traffic_growth integer,
  name text NOT NULL DEFAULT '', role text NOT NULL DEFAULT '', email text NOT NULL DEFAULT '',
  verification text NOT NULL DEFAULT 'unknown', source_url text NOT NULL DEFAULT '', extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT higuchi_prospect_record_verification_check CHECK (verification IN ('valid','invalid','catch_all','unknown'))
);
CREATE UNIQUE INDEX IF NOT EXISTS higuchi_prospect_record_key_uq ON higuchi_prospect_records(dataset_id,external_key);
CREATE INDEX IF NOT EXISTS higuchi_prospect_record_domain_idx ON higuchi_prospect_records(dataset_id,domain);
CREATE INDEX IF NOT EXISTS higuchi_prospect_record_location_idx ON higuchi_prospect_records(location);
CREATE TABLE IF NOT EXISTS higuchi_refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  session_id text NOT NULL, payment_intent_id text, charge_id text, currency text NOT NULL, amount_minor integer NOT NULL,
  price_version text NOT NULL, purchased_at timestamptz NOT NULL, qualified_at timestamptz NOT NULL,
  sent_count integer NOT NULL, positive_count integer NOT NULL, status text NOT NULL DEFAULT 'requested', requested_by text NOT NULL,
  note text NOT NULL DEFAULT '', reviewed_by text, stripe_refund_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT higuchi_refund_request_status_check CHECK (status IN ('requested','reviewing','approved','rejected','refunded')),
  CONSTRAINT higuchi_refund_request_currency_check CHECK (currency IN ('JPY','USD')),
  CONSTRAINT higuchi_refund_request_amount_check CHECK (amount_minor>0)
);
CREATE UNIQUE INDEX IF NOT EXISTS higuchi_refund_request_payment_uq ON higuchi_refund_requests(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS higuchi_refund_stripe_uq ON higuchi_refund_requests(stripe_refund_id);
CREATE INDEX IF NOT EXISTS higuchi_refund_request_org_idx ON higuchi_refund_requests(organization_id);
CREATE INDEX IF NOT EXISTS higuchi_refund_request_status_idx ON higuchi_refund_requests(status,created_at);
