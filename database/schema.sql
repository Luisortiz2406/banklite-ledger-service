-- Esquema de ledger_db (ledger-service). Generado con pg_dump --schema-only desde la base
-- que crea TypeORM a partir de las entidades (src/**/entities, synchronize: true).
-- Restaurar en una base vacía:  psql "$DATABASE_URL" -f database/schema.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_audit; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    staff_id character varying NOT NULL,
    staff_username character varying NOT NULL,
    action character varying NOT NULL,
    target_type character varying NOT NULL,
    target_id character varying NOT NULL,
    reason character varying(300),
    details jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    staff_role character varying
);


--
-- Name: ledger_balances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_balances (
    account_id uuid NOT NULL,
    currency character varying(3) NOT NULL,
    balance numeric(18,2) DEFAULT '0'::numeric NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: ledger_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_entries (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    transaction_id uuid NOT NULL,
    account_id uuid NOT NULL,
    amount numeric(18,2) NOT NULL,
    currency character varying(3) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ledger_outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_outbox (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    routing_key character varying NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    published_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    last_error character varying(500),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ledger_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ledger_transactions (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    idempotency_key uuid NOT NULL,
    user_id uuid,
    type character varying NOT NULL,
    source_account_id uuid,
    destination_account_id uuid NOT NULL,
    source_account_number character varying(11),
    destination_account_number character varying(11),
    reversed_transaction_id uuid,
    amount numeric(18,2) NOT NULL,
    currency character varying(3) NOT NULL,
    description character varying(140) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_audit PK_5ad48a4d9d16397ef37e28bb0be; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit
    ADD CONSTRAINT "PK_5ad48a4d9d16397ef37e28bb0be" PRIMARY KEY (id);


--
-- Name: ledger_transactions PK_633d103c9e415d615aacf9b1929; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_transactions
    ADD CONSTRAINT "PK_633d103c9e415d615aacf9b1929" PRIMARY KEY (id);


--
-- Name: ledger_entries PK_6efcb84411d3f08b08450ae75d5; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT "PK_6efcb84411d3f08b08450ae75d5" PRIMARY KEY (id);


--
-- Name: ledger_outbox PK_d3e8d91ae06b9e921f031eff3ab; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_outbox
    ADD CONSTRAINT "PK_d3e8d91ae06b9e921f031eff3ab" PRIMARY KEY (id);


--
-- Name: ledger_balances PK_dfa064bd5345d414674dddf1ccc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ledger_balances
    ADD CONSTRAINT "PK_dfa064bd5345d414674dddf1ccc" PRIMARY KEY (account_id);


--
-- Name: IDX_01ff7d3a76be6b7ca5fd33761d; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_01ff7d3a76be6b7ca5fd33761d" ON public.ledger_transactions USING btree (idempotency_key);


--
-- Name: IDX_08c8a33602676ce54af11c5ae5; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_08c8a33602676ce54af11c5ae5" ON public.ledger_transactions USING btree (reversed_transaction_id) WHERE (reversed_transaction_id IS NOT NULL);


--
-- Name: IDX_8decd83b4b9593f5219e5f3085; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "IDX_8decd83b4b9593f5219e5f3085" ON public.admin_audit USING btree (target_id);


--
-- Name: idx_admin_audit_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_created ON public.admin_audit USING btree (created_at);


--
-- Name: idx_ledger_entries_account_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_entries_account_created ON public.ledger_entries USING btree (account_id, created_at);


--
-- Name: idx_ledger_outbox_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ledger_outbox_pending ON public.ledger_outbox USING btree (published_at, created_at);


--
-- PostgreSQL database dump complete
--


